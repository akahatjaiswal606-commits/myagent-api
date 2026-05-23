import express from "express";
import cors from "cors";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Razorpay from "razorpay";
import crypto from "crypto";

const serviceAccount = JSON.parse(
  process.env["FIREBASE_SERVICE_ACCOUNT_JSON"]!
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"]!);

const razorpay = new Razorpay({
  key_id: process.env["RAZORPAY_KEY_ID"]!,
  key_secret: process.env["RAZORPAY_KEY_SECRET"]!,
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok" });
});

const verifyToken = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    req.userRef = db.collection("users").doc(decoded.uid);
    next();
  } catch (err: any) {
    res.status(401).json({ error: "Invalid token" });
  }
};

const checkPlan = async (req: any, res: any, next: any) => {
  try {
    const userDoc = await req.userRef.get();
    const userData = userDoc.data();
    const plan = userData?.plan || "free";
    const monthlyMessages = userData?.monthlyMessages || 0;
    const limits: Record<string, number> = { free: 50, pro: 1000, enterprise: 99999 };
    if (monthlyMessages >= (limits[plan] || 50)) {
      res.status(403).json({ error: "Monthly message limit reached" });
      return;
    }
    next();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

app.post("/api/agent/create", verifyToken, checkPlan, async (req: any, res: any): Promise<void> => {
  try {
    const { name, type, prompt, tone, language } = req.body;
    const user = req.user;
    const userRef = req.userRef;
    if (!prompt) { res.status(400).json({ error: "Prompt is required" }); return; }
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(
      `You are an AI agent builder. A user wants to create a "${type}" AI agent named "${name}". Tone: ${tone || "Professional"} Language: ${language || "English"} Description: "${prompt}" Respond AS the agent. Under 300 words.`
    );
    const agentResponse = result.response.text();
    const agentRef = await db.collection("agents").add({
      userId: user.uid, name, type, prompt, tone, language, agentResponse,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await userRef.update({
      agentCount: admin.firestore.FieldValue.increment(1),
      monthlyMessages: admin.firestore.FieldValue.increment(1),
    });
    res.json({ agentId: agentRef.id, agentResponse });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/agent/chat", verifyToken, checkPlan, async (req: any, res: any): Promise<void> => {
  try {
    const { agentId, userMessage } = req.body;
    const user = req.user;
    const userRef = req.userRef;
    const agentDoc = await db.collection("agents").doc(agentId).get();
    if (!agentDoc.exists) { res.status(404).json({ error: "Agent not found" }); return; }
    const agent = agentDoc.data()!;
    if (agent["userId"] !== user.uid) { res.status(403).json({ error: "Access denied" }); return; }
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: `You are ${agent["name"]}, a ${agent["type"]} AI agent. Tone: ${agent["tone"]}. Language: ${agent["language"]}. Your purpose: ${agent["prompt"]}`,
    });
    const chat = model.startChat();
    const result = await chat.sendMessage(userMessage);
    const reply = result.response.text();
    await db.collection("chats").add({
      agentId, userId: user.uid, userMessage, agentReply: reply,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    await userRef.update({ monthlyMessages: admin.firestore.FieldValue.increment(1) });
    res.json({ reply });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/agent/list", verifyToken, async (req: any, res: any): Promise<void> => {
  try {
    const user = req.user;
    const snapshot = await db.collection("agents").where("userId", "==", user.uid).orderBy("createdAt", "desc").get();
    res.json(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/agent/:id", verifyToken, async (req: any, res: any): Promise<void> => {
  try {
    const user = req.user;
    const userRef = req.userRef;
    const agentId = req.params["id"] as string;
    const agentDoc = await db.collection("agents").doc(agentId).get();
    if (agentDoc.data()?.["userId"] !== user.uid) { res.status(403).json({ error: "Access denied" }); return; }
    await db.collection("agents").doc(agentId).delete();
    await userRef?.update({ agentCount: admin.firestore.FieldValue.increment(-1) });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/payment/create-order", verifyToken, async (req: any, res: any): Promise<void> => {
  try {
    const { plan } = req.body;
    const user = req.user;
    const prices: Record<string, number> = { pro: 99900, enterprise: 499900 };
    const amount = prices[plan];
    if (!amount) { res.status(400).json({ error: "Invalid plan" }); return; }
    const order = await razorpay.orders.create({
      amount, currency: "INR",
      receipt: `order_${user.uid}_${Date.now()}`,
      notes: { userId: user.uid, plan },
    });
    res.json({ orderId: order.id, amount, currency: "INR" });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/payment/verify", verifyToken, async (req: any, res: any): Promise<void> => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSign = crypto.createHmac("sha256", process.env["RAZORPAY_KEY_SECRET"]!).update(sign).digest("hex");
    if (expectedSign !== razorpay_signature) { res.status(400).json({ error: "Payment verification failed" }); return; }
    const user = req.user;
    await db.collection("users").doc(user.uid).update({
      plan, planActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentId: razorpay_payment_id,
    });
    res.json({ success: true, plan });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);
app.listen(port, () => console.log(`✅ MyAgent.io server running on port ${port}`));
