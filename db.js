/**
 * Pure JavaScript File Database Engine (No C++ Native Bindings Required)
 * Stores tables: campaigns, leads, accounts matching the exact specification schema.
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'campaigns.json');

// Initial Schema Structure
const initialData = {
  accounts: [], // [{ id, email, password, host, port, created_at }]
  campaigns: [], // [{ id, title, status, draft_breakdown, value_prop, sender_name, created_at }]
  leads: [] // [{ id, campaign_id, first_name, company_name, email, trigger_note, draft_account_id, status, created_at }]
};

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
      return initialData;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading database file:', err);
    return initialData;
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing database file:', err);
  }
}

console.log('💾 Database initialized cleanly at campaigns.json');

module.exports = {
  // Accounts
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

  // Campaigns
  createCampaign({ id, title, status = 'draft', valueProp, senderName, leads = [] }) {
    const data = readDB();
    const now = new Date().toISOString();

    const campaignObj = {
      id: id,
      title: title || `Campaign - ${new Date().toLocaleDateString()}`,
      status: status, // 'draft' | 'paused' | 'running' | 'completed' | 'scheduled'
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
        draft_account_id: null, // Foreign Key to accounts.id
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
  }
};
