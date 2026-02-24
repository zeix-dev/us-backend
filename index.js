const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

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
// ✅ CREATE ORDER
// =================================================
app.post("/create-order", async (req, res) => {
  try {
    const { price, quantity = 1, couponCode } = req.body;

    if (!price || price <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    let total = Number(price) * Number(quantity);

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
      productId: productId || null,
      quantity: quantity || 1,
      couponCode: couponCode || null,
      amount: Number(finalAmount),
      paymentId: razorpay_payment_id,
      customerName,
      customerEmail,
      createdAt: new Date()
    });

    // ===== GENERATE INVOICE =====
    const invoiceName = `invoice-${orderRef.id}.pdf`;
    const filePath = path.join(__dirname, invoiceName);

    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(filePath));

    doc.fontSize(20).text("MuscleOxy Nutrition Invoice", { align: "center" });
    doc.moveDown();
    doc.text(`Order ID: ${orderRef.id}`);
    doc.text(`Payment ID: ${razorpay_payment_id}`);
    doc.text(`Customer: ${customerName}`);
    doc.text(`Email: ${customerEmail}`);
    doc.text(`Product ID: ${productId || "-"}`);
    doc.text(`Quantity: ${quantity || 1}`);
    doc.text(`Total Paid: ₹${finalAmount}`);
    doc.text(`Date: ${new Date().toLocaleString()}`);

    doc.end();

    res.json({
      success: true,
      invoiceUrl: `${req.protocol}://${req.get("host")}/${invoiceName}`
    });

  } catch (err) {
    console.log("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ================= STATIC =================
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));