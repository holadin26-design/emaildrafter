/**
 * Pure JavaScript Database Engine (Vercel Read-Only File System Compliant)
 * Stores tables: campaigns, leads, accounts, followups with in-memory & /tmp fallback for Vercel Serverless.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const isVercel = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
const DB_FILE = isVercel ? path.join(os.tmpdir(), 'campaigns.json') : path.join(__dirname, 'campaigns.json');

// In-Memory Fallback State for Serverless Cold Starts
let memoryStore = {
  accounts: [],
  campaigns: [],
  leads: [],
  followups: []
};

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Ensure followups collection exists on old data
      if (!parsed.followups) parsed.followups = [];
      memoryStore = parsed;
    }
  } catch (err) {
    console.warn('Vercel DB Read Warning (using memory store):', err.message);
  }
  return memoryStore;
}

function writeDB(data) {
  memoryStore = data;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    // Read-only filesystem on Vercel - graceful fallback to memoryStore
    console.warn('Vercel File System Read-Only (persisted in memory state):', err.message);
  }
}

module.exports = {
  upsertAccount(acc) {
    const data = readDB();
    const id = acc.id || acc.email;
    const idx = data.accounts.findIndex(a => a.id === id || a.email === acc.email);
    const now = new Date().toISOString();

    const accountObj = {
      id: id,
      email: acc.email,
      password: acc.password || '',
      host: acc.host || (acc.email.includes('@gmail.com') ? 'imap.gmail.com' : 'imap.mail.yahoo.com'),
      port: acc.port || 993,
      created_at: now
    };

    if (idx >= 0) {
      data.accounts[idx] = { ...data.accounts[idx], ...accountObj };
    } else {
      data.accounts.push(accountObj);
    }

    writeDB(data);
    return id;
  },

  getAllAccounts() {
    return readDB().accounts;
  },

  getAccountByEmail(email) {
    return readDB().accounts.find(a => a.email === email);
  },

  createCampaign({ id, title, status = 'draft', template, valueProp, senderName, leads = [] }) {
    const data = readDB();
    const now = new Date().toISOString();

    const campaignObj = {
      id: id,
      title: title || `Campaign - ${new Date().toLocaleDateString()}`,
      status: status,
      template: template || {},
      draft_breakdown: [],
      value_prop: valueProp || '',
      sender_name: senderName || '',
      created_at: now
    };

    data.campaigns.push(campaignObj);

    leads.forEach((l, idx) => {
      data.leads.push({
        id: `${id}_lead_${idx}`,
        campaign_id: id,
        first_name: l.first_name || l.firstName || '',
        company_name: l.company_name || l.company || '',
        email: l.email,
        trigger_note: l.trigger || l.trigger_note || '',
        draft_account_id: null,
        status: 'pending',
        created_at: now
      });
    });

    writeDB(data);
    return id;
  },

  getCampaign(id) {
    const data = readDB();
    const campaign = data.campaigns.find(c => c.id === id);
    if (!campaign) return null;

    const leads = data.leads.filter(l => l.campaign_id === id);
    return {
      ...campaign,
      leads: leads
    };
  },

  updateCampaignDraftBreakdown(id, breakdownSummary) {
    const data = readDB();
    const campaign = data.campaigns.find(c => c.id === id);
    if (campaign) {
      campaign.draft_breakdown = breakdownSummary;
      writeDB(data);
    }
  },

  updateCampaignStatus(id, status) {
    const data = readDB();
    const campaign = data.campaigns.find(c => c.id === id);
    if (campaign) {
      campaign.status = status;
      writeDB(data);
    }
  },

  updateLeadDraftAccount(leadId, accountId) {
    const data = readDB();
    const lead = data.leads.find(l => l.id === leadId);
    if (lead) {
      lead.draft_account_id = accountId;
      writeDB(data);
    }
  },

  // --- Follow-Up Methods ---

  saveFollowup({ fromAccount, toEmail, originalSubject, originalMessageId, followUpSubject, followUpBody }) {
    const data = readDB();
    if (!data.followups) data.followups = [];

    const existing = data.followups.find(f =>
      f.fromAccount === fromAccount && f.originalMessageId === originalMessageId
    );
    if (existing) return existing.id; // Already saved, skip

    const id = 'fu_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    data.followups.push({
      id,
      fromAccount,
      toEmail,
      originalSubject,
      originalMessageId,
      followUpSubject,
      followUpBody,
      savedAt: new Date().toISOString()
    });

    writeDB(data);
    return id;
  },

  getAllFollowups() {
    const data = readDB();
    return data.followups || [];
  },

  wasFollowupSent(fromAccount, originalMessageId) {
    const data = readDB();
    if (!data.followups) return false;
    return data.followups.some(f =>
      f.fromAccount === fromAccount && f.originalMessageId === originalMessageId
    );
  }
};
