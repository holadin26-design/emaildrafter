/**
 * IMAP Draft Engine Server (Node.js + Express + ImapFlow + SQLite DB)
 * Appends RFC 822 formatted cold email drafts directly into Gmail / Outlook / Custom IMAP Drafts folders
 * and persists campaign status and lead draft_account_id in SQL database.
 */

const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const MailComposer = require('nodemailer/lib/mail-composer');
const DB = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/**
 * Utility: Auto-detect IMAP Drafts mailbox folder name
 */
async function detectDraftsMailbox(client) {
  try {
    const mailboxes = await client.list();
    
    // 1. Check special-use flag \Drafts
    for (const box of mailboxes) {
      if (box.flags && (box.flags.has('\\Drafts') || box.specialUse === '\\Drafts')) {
        return box.path;
      }
    }

    // 2. Fallback folder names by priority
    const candidates = ['[Gmail]/Drafts', 'Drafts', 'INBOX.Drafts', 'Draft'];
    for (const cand of candidates) {
      const found = mailboxes.find(m => m.path.toLowerCase() === cand.toLowerCase());
      if (found) return found.path;
    }

    return 'Drafts';
  } catch (err) {
    console.warn('Folder auto-detection fallback to Drafts:', err.message);
    return 'Drafts';
  }
}

/**
 * Utility: Format RFC 822 Raw Email Message
 */
async function buildRfc822Message({ fromName, fromEmail, toEmail, subject, bodyText, bodyHtml }) {
  const mail = new MailComposer({
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to: toEmail,
    subject: subject,
    text: bodyText || bodyHtml.replace(/<[^>]+>/g, ''),
    html: bodyHtml || bodyText.replace(/\n/g, '<br>')
  });

  return await mail.compile().build();
}

// ==========================================
// 1. Create Draft Campaign
// POST /api/campaigns
// ==========================================
app.post('/api/campaigns', (req, res) => {
  const { title, accounts, leads, template, valueProp, senderName, draftMode = true } = req.body;

  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'Leads array is required' });
  }

  // Save/Upsert Sender Accounts to Database
  if (accounts && Array.isArray(accounts)) {
    accounts.forEach(acc => {
      DB.upsertAccount(acc);
    });
  }

  const campaignId = 'camp_' + Date.now();
  const status = draftMode ? 'draft' : 'running';

  DB.createCampaign({
    id: campaignId,
    title: title || `Cold Email Campaign - ${new Date().toLocaleDateString()}`,
    status: status,
    valueProp: valueProp || '',
    senderName: senderName || '',
    leads: leads
  });

  return res.status(201).json({
    success: true,
    campaignId: campaignId,
    status: status,
    message: 'Campaign stored in SQL database with draft status'
  });
});

// ==========================================
// 2. Save Drafts to IMAP Mailboxes & Database
// POST /api/campaigns/:id/save-drafts
// ==========================================
app.post('/api/campaigns/:id/save-drafts', async (req, res) => {
  const { id } = req.params;
  const { force = false, imapCredentials = [] } = req.body;

  const campaign = DB.getCampaign(id);
  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found in database' });
  }

  if (campaign.status !== 'draft' && !force) {
    return res.status(400).json({ error: `Campaign status is ${campaign.status}, cannot save drafts.` });
  }

  // Check duplicate draft generation
  if (campaign.draft_breakdown && campaign.draft_breakdown.length > 0 && !force) {
    return res.json({
      success: true,
      message: 'Drafts already generated for this campaign',
      summary: campaign.draft_breakdown
    });
  }

  // Retrieve accounts from payload or database
  let accounts = imapCredentials && imapCredentials.length > 0 ? imapCredentials : DB.getAllAccounts();
  if (!accounts || accounts.length === 0) {
    return res.status(400).json({ error: 'No IMAP sender accounts configured.' });
  }

  // Ensure accounts exist in DB
  accounts.forEach(acc => DB.upsertAccount(acc));

  const summary = [];
  const warnings = [];

  // Group leads round-robin by account
  const accountLeadMap = new Map();
  accounts.forEach((acc, i) => {
    const accId = DB.upsertAccount(acc);
    accountLeadMap.set(accId, { account: acc, accountId: accId, leads: [] });
  });

  const accList = Array.from(accountLeadMap.keys());
  campaign.leads.forEach((lead, i) => {
    const targetAccId = accList[i % accList.length];
    accountLeadMap.get(targetAccId).leads.push(lead);
  });

  // Process IMAP Appending for each account
  for (const [accId, { account, leads }] of accountLeadMap.entries()) {
    if (leads.length === 0) continue;

    const host = account.host || (account.email.includes('@gmail.com') ? 'imap.gmail.com' : 'imap.mail.yahoo.com');
    const port = account.port || 993;
    const user = account.user || account.email;
    const pass = account.password || account.appPassword;

    if (!pass) {
      warnings.push(`Account ${user} skipped: IMAP password/App password missing.`);
      summary.push({ accountId: accId, email: user, draftsAdded: 0, status: 'failed_missing_password' });
      continue;
    }

    const client = new ImapFlow({
      host: host,
      port: port,
      secure: true,
      auth: { user: user, pass: pass },
      logger: false
    });

    let draftsAdded = 0;

    try {
      await client.connect();
      const draftsFolder = await detectDraftsMailbox(client);

      for (const lead of leads) {
        const context = {
          first_name: lead.first_name || lead.firstName || 'there',
          company_name: lead.company_name || lead.company || 'your team',
          email: lead.email || '',
          trigger: lead.trigger_note || lead.trigger || 'doing great work',
          value_prop: campaign.value_prop || '',
          sender_name: campaign.sender_name || account.senderName || user
        };

        let subject = 'Quick idea for {{company_name}}';
        let body = 'Hi {{first_name}},\n\nNoticed {{company_name}} has been {{trigger}}.\n\n{{value_prop}}\n\nBest,\n{{sender_name}}';

        Object.keys(context).forEach(k => {
          const regex = new RegExp(`{{\\s*${k}\\s*}}`, 'gi');
          subject = subject.replace(regex, context[k]);
          body = body.replace(regex, context[k]);
        });

        const rawMime = await buildRfc822Message({
          fromName: campaign.sender_name || user.split('@')[0],
          fromEmail: user,
          toEmail: lead.email,
          subject: subject,
          bodyText: body,
          bodyHtml: body.replace(/\n/g, '<br>')
        });

        // Append to IMAP Drafts folder
        await client.append(draftsFolder, rawMime, ['\\Draft']);
        draftsAdded++;

        // Update database: lead.draft_account_id = accId
        DB.updateLeadDraftAccount(lead.id, accId);
      }

      await client.logout();

      summary.push({
        accountId: accId,
        email: user,
        draftsAdded: draftsAdded,
        draftsFolder: draftsFolder,
        status: 'success'
      });

    } catch (err) {
      console.error(`IMAP Draft Error for ${user}:`, err.message);
      warnings.push(`IMAP connection failed for ${user}: ${err.message}`);
      summary.push({
        accountId: accId,
        email: user,
        draftsAdded: draftsAdded,
        status: 'failed',
        error: err.message
      });
    }
  }

  // Update campaign draft_breakdown in SQL database
  DB.updateCampaignDraftBreakdown(id, summary);

  return res.json({
    success: true,
    message: `Generated drafts for ${summary.reduce((a, b) => a + b.draftsAdded, 0)} leads across IMAP accounts.`,
    summary: summary,
    warnings: warnings.length > 0 ? warnings : undefined
  });
});

// ==========================================
// 3. Launch Draft Campaign
// POST /api/campaigns/:id/launch-draft
// ==========================================
app.post('/api/campaigns/:id/launch-draft', (req, res) => {
  const { id } = req.params;
  const campaign = DB.getCampaign(id);

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found in database' });
  }

  DB.updateCampaignStatus(id, 'running');

  return res.json({
    success: true,
    message: 'Campaign updated in SQL database from draft to running status.',
    campaign: {
      id: campaign.id,
      status: 'running',
      draft_breakdown: campaign.draft_breakdown
    }
  });
});

// ==========================================
// 4. Get Campaign Details
// GET /api/campaigns/:id
// ==========================================
app.get('/api/campaigns/:id', (req, res) => {
  const campaign = DB.getCampaign(req.params.id);
  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found in database' });
  }
  return res.json({ success: true, campaign });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 IMAP Draft Engine & SQL Database API running at http://localhost:${PORT}`);
});
