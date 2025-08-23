import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Disable CSP for Google Drive integration - Google's scripts require full access
// app.use((req, res, next) => {
//   res.setHeader('Content-Security-Policy', "...");
//   next();
// });

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));


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
    type: { type: String, enum: ['receipt', 'check', 'deposit_slip', 'other'], default: 'other' }
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
  console.log("Getting next trans_id...");
  const lastEntry = await JournalEntry.findOne().sort({ trans_id: -1 });
  console.log("Last entry:", lastEntry);
  return lastEntry ? lastEntry.trans_id + 1 : 1;  
} 
// --- Routes ---
// Create journal entry
app.post("/journal", async (req, res) => {
  console.log("Received request body:", req.body);  // Add this log
  try {
    const trans_id = await getNextTid();
    const entry = new JournalEntry({ ...req.body, trans_id });
    await entry.save();
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all journal entries
app.get("/journal", async (req, res) => {
  try {
    const entries = await JournalEntry.find().sort({ date: -1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to check collections and entry 59
app.get("/debug/collections", async (req, res) => {
  try {
    console.log('\n=== DEBUG: Checking Collections ===');
    
    // List all collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Available collections:', collections.map(c => c.name));
    
    // Check current collection
    console.log('Current model collection:', JournalEntry.collection.name);
    console.log('Database name:', JournalEntry.db.databaseName);
    
    // Count entries in current collection
    const currentCount = await JournalEntry.countDocuments();
    console.log(`Entries in current collection: ${currentCount}`);
    
    // Try to find entry 59 in different possible collections
    const possibleCollections = ['journalentries', 'JournalEntry', 'journal_entries'];
    const results = {};
    
    for (const collectionName of possibleCollections) {
      try {
        const collection = mongoose.connection.db.collection(collectionName);
        const count = await collection.countDocuments();
        const entry59 = await collection.findOne({ trans_id: "59" });
        const entry59Num = await collection.findOne({ trans_id: 59 });
        
        results[collectionName] = {
          exists: count > 0,
          totalEntries: count,
          hasEntry59String: !!entry59,
          hasEntry59Number: !!entry59Num
        };
        
        console.log(`Collection "${collectionName}": ${count} entries, entry 59 as string: ${!!entry59}, as number: ${!!entry59Num}`);
      } catch (err) {
        results[collectionName] = { error: err.message };
      }
    }
    
    res.json({
      availableCollections: collections.map(c => c.name),
      currentCollection: JournalEntry.collection.name,
      database: JournalEntry.db.databaseName,
      currentCollectionCount: currentCount,
      collectionTests: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single journal entry (using MongoDB _id)
app.get("/journal/:id", async (req, res) => {
  try {
    console.log(`Looking for journal entry with ID: ${req.params.id}`);
    
    // Always use MongoDB _id for lookups
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: "Invalid journal entry ID format" });
    }
    
    const entry = await JournalEntry.findById(req.params.id);
    
    if (!entry) {
      console.log(`No entry found for MongoDB _id: ${req.params.id}`);
      return res.status(404).json({ error: "Journal entry not found" });
    }
    
    console.log(`✅ Found entry: trans_id=${entry.trans_id}, desc="${entry.description}"`);
    res.json(entry);
  } catch (err) {
    console.log(`❌ Error finding entry: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Update journal entry (using MongoDB _id)
app.put("/journal/:id", async (req, res) => {
  try {
    // Always use MongoDB _id for updates
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: "Invalid journal entry ID format" });
    }
    
    const updated = await JournalEntry.findByIdAndUpdate(req.params.id, req.body, { new: true });
    
    if (!updated) {
      return res.status(404).json({ error: "Journal entry not found" });
    }
    
    console.log(`✅ Updated entry: trans_id=${updated.trans_id}, desc="${updated.description}"`);
    res.json(updated);
  } catch (err) {
    console.log(`❌ Error updating entry: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Delete journal entry
app.delete("/journal/:id", async (req, res) => {
  try {
    const deleted = await JournalEntry.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Journal entry not found" });
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chart of accounts
app.post("/accounts", async (req, res) => {
  try {
    // Check for duplicate account number
    const existing = await Account.findOne({ number: req.body.number });
    if (existing) {
      return res.status(400).json({ error: "Account number already exists" });
    }
    const acc = new Account(req.body);
    await acc.save();
    res.json(acc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/accounts", async (req, res) => {
  try {
    const accounts = await Account.find().sort({ number: 1 });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update account
app.put("/accounts/:id", async (req, res) => {
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

// Delete account
app.delete("/accounts/:id", async (req, res) => {
  try {
    const deleted = await Account.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Account not found" });
    res.sendStatus(204);
  } catch (err) {
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

// Serve index.html for root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start ---
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`🚀 API running on http://localhost:${port}`));
