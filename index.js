 const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const PDFDocument = require("pdfkit");
const fs = require("fs");

console.log("ENV CHECK:", process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});


// ✅ CREATE ORDER WITH COUPON
app.post("/create-order", async (req, res) => {
  try {
    const { productId, quantity, couponCode } = req.body;

    const productDoc = await db.collection("products").doc(productId).get();
    if (!productDoc.exists) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = productDoc.data();
    let total = product.price * quantity;

    // ✅ Coupon Apply
    if (couponCode) {
      const couponDoc = await db.collection("coupons").doc(couponCode).get();
      if (couponDoc.exists) {
        const coupon = couponDoc.data();
        if (coupon.type === "percentage") {
          total -= (total * coupon.value) / 100;
        } else if (coupon.type === "flat") {
          total -= coupon.value;
        }
      }
    }

    total = Math.max(total, 1);

    const order = await razorpay.orders.create({
      amount: Math.round(total * 100),
      currency: "INR"
    });

    res.json({ order, finalAmount: total });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Order failed" });
  }
});


// ✅ VERIFY + SAVE ORDER + GENERATE INVOICE
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
      return res.status(400).json({ success: false });
    }

    // ✅ Save Order
    const orderRef = await db.collection("orders").add({
      productId,
      quantity,
      couponCode: couponCode || null,
      amount: finalAmount,
      paymentId: razorpay_payment_id,
      customerName,
      customerEmail,
      createdAt: new Date()
    });

    // ✅ Generate Invoice PDF
    const doc = new PDFDocument();
    const filePath = `invoice-${orderRef.id}.pdf`;

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
      invoiceUrl: `https://us-backend-ltwc.onrender.com/${filePath}`
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Verification failed" });
  }
});


app.use(express.static("./"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running"));