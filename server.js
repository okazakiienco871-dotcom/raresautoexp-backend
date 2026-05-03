const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// ============================================================
// CLOUDINARY CONFIG
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ============================================================
// MONGODB
// ============================================================
let db;
async function connectDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('raresautoexp');
  console.log('MongoDB connected');
}

// ============================================================
// CORS
// ============================================================
const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? [process.env.ALLOWED_ORIGIN]
  : ['http://localhost', 'http://127.0.0.1'];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o.replace(/\/$/, '')))) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '20mb' }));

// ============================================================
// HELPERS
// ============================================================

// Upload a base64 image to Cloudinary, return secure URL
async function uploadPhoto(base64, productId) {
  const result = await cloudinary.uploader.upload(base64, {
    folder: `raresautoexp/products/${productId}`,
    resource_type: 'image',
    transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }]
  });
  return { url: result.secure_url, public_id: result.public_id };
}

// Delete a photo from Cloudinary by public_id
async function deletePhoto(public_id) {
  try { await cloudinary.uploader.destroy(public_id); } catch(e) {}
}

// Serialize MongoDB doc to plain object (convert _id to id)
function serialize(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

// ============================================================
// PRODUCT API
// ============================================================

// GET all products
app.get('/api/products', async (req, res) => {
  try {
    const docs = await db.collection('products').find({}).sort({ createdAt: 1 }).toArray();
    res.json(docs.map(serialize));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create product
app.post('/api/products', async (req, res) => {
  try {
    const { photos: rawPhotos = [], ...meta } = req.body;

    // Upload any base64 photos to Cloudinary
    const tempId = new ObjectId();
    const photos = await Promise.all(rawPhotos.map(p =>
      p.startsWith('data:') ? uploadPhoto(p, tempId.toString()) : Promise.resolve({ url: p, public_id: null })
    ));

    const doc = { ...meta, photos, createdAt: new Date(), _id: tempId };
    await db.collection('products').insertOne(doc);
    res.json(serialize(doc));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const existing = await db.collection('products').findOne({ _id });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { photos: rawPhotos = [], ...meta } = req.body;

    // Split incoming photos into existing (already have a URL from Cloudinary) and new (base64)
    const keptPhotos = rawPhotos
      .filter(p => !p.startsWith('data:'))
      .map(url => {
        const found = (existing.photos || []).find(ep => ep.url === url);
        return found || { url, public_id: null };
      });

    const newBase64 = rawPhotos.filter(p => p.startsWith('data:'));

    // Delete photos that were removed
    const keptUrls = keptPhotos.map(p => p.url);
    const toDelete = (existing.photos || []).filter(ep => !keptUrls.includes(ep.url));
    await Promise.all(toDelete.map(ep => ep.public_id ? deletePhoto(ep.public_id) : Promise.resolve()));

    // Upload new photos
    const newPhotos = await Promise.all(newBase64.map(b64 => uploadPhoto(b64, req.params.id)));

    const photos = [...keptPhotos, ...newPhotos];
    const updated = { ...meta, photos, updatedAt: new Date() };
    await db.collection('products').updateOne({ _id }, { $set: updated });
    res.json(serialize({ _id, ...updated }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const doc = await db.collection('products').findOne({ _id });
    if (doc) {
      // Delete all photos from Cloudinary
      await Promise.all((doc.photos || []).map(p => p.public_id ? deletePhoto(p.public_id) : Promise.resolve()));
      await db.collection('products').deleteOne({ _id });
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// STRIPE ROUTES
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'Rares Auto Export server running', ok: true }));

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', customerEmail, customerName, items } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      receipt_email: customerEmail,
      metadata: {
        customerName: customerName || '',
        itemCount: items ? items.length : 0,
        itemSummary: items ? items.map(i => `${i.name} x${i.qty}`).join(', ').substring(0, 500) : ''
      }
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch(err) {
    console.error('PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
