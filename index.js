const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const PDFDocument = require("pdfkit");
const fs = require("fs");

// ================= ENV CHECK =================
if (!process.env.SERVICE_ACCOUNT_KEY) {
  console.error("SERVICE_ACCOUNT_KEY missing!");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// ================= RAZORPAY =================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ================= HEALTH CHECK =================
app.get("/", (req, res) => {
  res.send("Backend running successfully 🚀");
});

// =================================================
// ✅ CREATE ORDER (FIXED + SAFE CALCULATION)
// =================================================
app.post("/create-order", async (req, res) => {
  try {
    const { productId, quantity = 1, couponCode } = req.body;

    const productDoc = await db.collection("products").doc(productId).get();
    if (!productDoc.exists) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = productDoc.data();
    let total = Number(product.price) * Number(quantity);

    // ===== APPLY COUPON =====
    if (couponCode) {
      const couponDoc = await db.collection("coupons").doc(couponCode).get();

      if (couponDoc.exists) {
        const coupon = couponDoc.data();

        if (coupon.type === "percent" || coupon.type === "percentage") {
          total = total - (total * Number(coupon.value)) / 100;
        }

        if (coupon.type === "flat") {
          total = total - Number(coupon.value);
        }
      }
    }

    total = Math.round(total);

    if (total < 1) total = 1;

    console.log("FINAL TOTAL:", total);
    console.log("RAZORPAY AMOUNT:", total * 100);

    const order = await razorpay.orders.create({
      amount: total * 100,
      currency: "INR"
    });

    res.json({ order, finalAmount: total });

  } catch (err) {
    console.log("CREATE ORDER ERROR:", err);
    res.status(500).json({ error: "Order failed" });
  }
});

// =================================================
// ✅ VERIFY PAYMENT + SAVE + INVOICE
// =================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      productId,
      quantity,
      couponCode,
      finalAmount,
      customerName,
      customerEmail
    } = req.body;

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    // ===== SAVE ORDER =====
    const orderRef = await db.collection("orders").add({
      productId,
      quantity,
      couponCode: couponCode || null,
      amount: Number(finalAmount),
      paymentId: razorpay_payment_id,
      customerName,
      customerEmail,
      createdAt: new Date()
    });

    // ===== GENERATE INVOICE =====
    const filePath = `invoice-${orderRef.id}.pdf`;
    const doc = new PDFDocument();

    doc.pipe(fs.createWriteStream(filePath));

    doc.fontSize(20).text("MuscleOxy Nutrition Invoice", { align: "center" });
    doc.moveDown();
    doc.text(`Order ID: ${orderRef.id}`);
    doc.text(`Payment ID: ${razorpay_payment_id}`);
    doc.text(`Customer: ${customerName}`);
    doc.text(`Email: ${customerEmail}`);
    doc.text(`Product ID: ${productId}`);
    doc.text(`Quantity: ${quantity}`);
    doc.text(`Total Paid: ₹${finalAmount}`);
    doc.text(`Date: ${new Date().toLocaleString()}`);

    doc.end();

    res.json({
      success: true,
      invoiceUrl: `${req.protocol}://${req.get("host")}/${filePath}`
    });

  } catch (err) {
    console.log("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ================= STATIC =================
app.use(express.static("./"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));