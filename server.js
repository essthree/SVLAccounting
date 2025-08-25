import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import MongoStore from "connect-mongo";
import { OAuth2Client } from "google-auth-library";
import { body, validationResult } from "express-validator";

dotenv.config();

const app = express();
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : 'http://localhost:4000',
  credentials: true
}));
app.use(express.json());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  store: MongoStore.create({ 
    mongoUrl: process.env.MONGO_URI,
    touchAfter: 24 * 3600 // lazy session update
  }),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: false, // Temporarily disable for debugging
    sameSite: 'lax'
  }
}));

// Google OAuth client
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Disable CSP for Google Drive integration - Google's scripts require full access
// app.use((req, res, next) => {
//   res.setHeader('Content-Security-Policy', "...");
//   next();
// });

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (req.session && req.session.user) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required. Please log in.' });
  }
};

// --- Mongo Connection ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("Mongo error:", err));

// --- Models ---
const accountSchema = new mongoose.Schema({
  number: Number,       // e.g. 1000
  name: String,
  description: String,  // e.g. "Bank Account"
  type: String          // Asset, Liability, Equity, Revenue, Expense
});
const Account = mongoose.model("Account", accountSchema, "accounts");

const entrySchema = new mongoose.Schema({
  trans_id: { type: mongoose.Schema.Types.Mixed, unique: true },
  date: { type: Date, default: Date.now },
  description: String,
  attachments: [{
    name: String,
    url: String,
    type: { type: String, enum: ['receipt', 'check', 'deposit_slip', 'other'], default: 'other' },
    mimeType: String
  }],
  lines: [{
    account_no: Number,
    account_name: String,
    account_ref: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account"
    },
    debit: Number,
    credit: Number
  }],
});
const JournalEntry = mongoose.model('JournalEntry', entrySchema, 'journalentries');

// --- Helpers ---
async function getNextTid() {
  //console.log("Getting next trans_id...");
  const lastEntry = await JournalEntry.findOne().sort({ trans_id: -1 });
  //console.log("Last entry:", lastEntry);
  return lastEntry ? lastEntry.trans_id + 1 : 1;  
} 
// --- Routes ---
// Authentication endpoints
app.post("/auth/google", async (req, res) => {
  try {
    const { token } = req.body;
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    req.session.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name
    };
    
    res.json({ success: true, user: req.session.user });
  } catch (error) {
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.json({ success: true });
  });
});

app.get("/auth/status", (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// Create journal entry (protected)
app.post("/journal", [
  body('description').isLength({ min: 1 }).trim().escape(),
  body('date').isISO8601(),
  body('lines').isArray({ min: 1 })
], requireAuth, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  try {
    const trans_id = await getNextTid();
    const entry = new JournalEntry({ ...req.body, trans_id });
    await entry.save();
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all journal entries (protected)
app.get("/journal", requireAuth, async (req, res) => {
  try {
    const entries = await JournalEntry.find().sort({ date: -1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to check collections and entry 59
// app.get("/debug/collections", async (req, res) => {
//   try {
//     //console.log('\n=== DEBUG: Checking Collections ===');
    
//     // List all collections
//     const collections = await mongoose.connection.db.listCollections().toArray();
//     //console.log('Available collections:', collections.map(c => c.name));
    
//     // Check current collection
//     //console.log('Current model collection:', JournalEntry.collection.name);
//     //console.log('Database name:', JournalEntry.db.databaseName);
    
//     // Count entries in current collection
//     const currentCount = await JournalEntry.countDocuments();
//     //console.log(`Entries in current collection: ${currentCount}`);
    
//     // Try to find entry 59 in different possible collections
//     const possibleCollections = ['journalentries', 'JournalEntry', 'journal_entries'];
//     const results = {};
    
//     for (const collectionName of possibleCollections) {
//       try {
//         const collection = mongoose.connection.db.collection(collectionName);
//         const count = await collection.countDocuments();
//         const entry59 = await collection.findOne({ trans_id: "59" });
//         const entry59Num = await collection.findOne({ trans_id: 59 });
        
//         results[collectionName] = {
//           exists: count > 0,
//           totalEntries: count,
//           hasEntry59String: !!entry59,
//           hasEntry59Number: !!entry59Num
//         };
        
//         //console.log(`Collection "${collectionName}": ${count} entries, entry 59 as string: ${!!entry59}, as number: ${!!entry59Num}`);
//       } catch (err) {
//         results[collectionName] = { error: err.message };
//       }
//     }
    
//     res.json({
//       availableCollections: collections.map(c => c.name),
//       currentCollection: JournalEntry.collection.name,
//       database: JournalEntry.db.databaseName,
//       currentCollectionCount: currentCount,
//       collectionTests: results
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// Get single journal entry (using MongoDB _id) (protected)
app.get("/journal/:id", requireAuth, async (req, res) => {
  try {
    // Always use MongoDB _id for queries
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }
    
    const entry = await JournalEntry.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: "Journal entry not found" });
    }
    
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update journal entry (using MongoDB _id) (protected)
app.put("/journal/:id", [
  body('description').isLength({ min: 1 }).trim().escape(),
  body('date').isISO8601(),
  body('lines').isArray({ min: 1 })
], requireAuth, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  try {
    // Always use MongoDB _id for updates
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: "Invalid journal entry ID format" });
    }

    const updated = await JournalEntry.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { new: true }
    );
    
    if (!updated) return res.status(404).json({ error: "Journal entry not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete journal entry (protected)
app.delete("/journal/:id", requireAuth, async (req, res) => {
  try {
    const deleted = await JournalEntry.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Journal entry not found" });
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chart of accounts (protected)
app.post("/accounts", [
  body('number').isInt({ min: 1 }),
  body('name').isLength({ min: 1 }).trim().escape()
], requireAuth, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  try {
    // Check for duplicate account number
    const existing = await Account.findOne({ number: req.body.number });
    if (existing) {
      return res.status(400).json({ error: "Account number already exists" });
    }
    const account = new Account(req.body);
    await account.save();
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/accounts", requireAuth, async (req, res) => {
  try {
    const accounts = await Account.find().sort({ number: 1 });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update account (protected)
app.put("/accounts/:id", [
  body('number').isInt({ min: 1 }),
  body('name').isLength({ min: 1 }).trim().escape()
], requireAuth, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  try {
    // Check for duplicate account number (excluding current account)
    const existing = await Account.findOne({ 
      number: req.body.number, 
      _id: { $ne: req.params.id } 
    });
    if (existing) {
      return res.status(400).json({ error: "Account number already exists" });
    }
    const updated = await Account.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: "Account not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete account (protected)
app.delete("/accounts/:id", requireAuth, async (req, res) => {
  try {
    const deleted = await Account.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Account not found" });
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to get Google Drive file metadata (including mimeType)
app.get("/api/drive-metadata/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;
    const { access_token } = req.query;
    
    // console.log('Drive metadata request for fileId:', fileId);
    // console.log('Access token present:', !!access_token);
    
    if (!access_token) {
      return res.status(400).json({ error: "Access token required" });
    }
    
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`, {
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });
    
    // console.log('Google Drive API response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google Drive API error:', response.status, errorText);
      throw new Error(`Google Drive API error: ${response.status}`);
    }
    
    const metadata = await response.json();
    // console.log('Retrieved metadata:', metadata);
    res.json(metadata);
  } catch (err) {
    console.error('Drive metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to provide frontend configuration
app.get("/api/config", (req, res) => {
  res.json({
    googleApiKey: process.env.GOOGLE_API_KEY,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    apiUrl: process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000'
  });
});

// Serve static frontend (before custom routes to ensure assets load)
app.use(express.static(path.join(__dirname, "public")));

// Serve general-journal.html for root route (override index.html)
app.get("/", (req, res) => {
  // Check if user is authenticated
  if (req.session && req.session.user) {
    res.sendFile(path.join(__dirname, "public", "general-journal.html"));
  } else {
    res.sendFile(path.join(__dirname, "public", "login.html"));
  }
});

// --- Start ---
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`🚀 API running on http://localhost:${port}`));
