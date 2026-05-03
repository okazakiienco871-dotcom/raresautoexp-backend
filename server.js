const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Allow requests from your website domain
const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? [process.env.ALLOWED_ORIGIN]
  : ['http://localhost', 'http://127.0.0.1'];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed => origin.startsWith(allowed.replace(/\/$/, '')))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'AutoCore Payments Server running', ok: true });
});

// Create a PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', customerEmail, customerName, items } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert dollars to cents
      currency,
      receipt_email: customerEmail,
      metadata: {
        customerName: customerName || '',
        itemCount: items ? items.length : 0,
        itemSummary: items ? items.map(i => `${i.name} x${i.qty}`).join(', ').substring(0, 500) : ''
      }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get Stripe publishable key (safe to expose)
app.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rares Auto Export payment server running on port ${PORT}`);
});
