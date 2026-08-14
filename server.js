/**
 * IMAP Draft Engine Server (Node.js + Express + ImapFlow + SQLite DB)
 * Appends RFC 822 formatted cold email drafts directly into Gmail / Outlook / Custom IMAP Drafts folders
 * and persists campaign status and lead draft_account_id in SQL database.
 *
 * NOW INCLUDES: AI Follow-Up Engine using OpenRouter API
 */

const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const MailComposer = require('nodemailer/lib/mail-composer');
const DB = require('./db');
const https = require('https');

const path = require('path');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

/**
 * Utility: Auto-detect IMAP Drafts mailbox folder name
 */
async function detectDraftsMailbox(client) {
  try {
    const mailboxes = await client.list();
    for (const box of mailboxes) {
      if (box.flags && (box.flags.has('\\Drafts') || box.specialUse === '\\Drafts')) {
        return box.path;
      }
    }
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
 * Utility: Auto-detect IMAP Sent mailbox folder name
 */
async function detectSentMailbox(client) {
  try {
    const mailboxes = await client.list();
    for (const box of mailboxes) {
      if (box.flags && (box.flags.has('\\Sent') || box.specialUse === '\\Sent')) {
        return box.path;
      }
    }
    const candidates = ['[Gmail]/Sent Mail', 'Sent', 'Sent Items', 'INBOX.Sent'];
    for (const cand of candidates) {
      const found = mailboxes.find(m => m.path.toLowerCase() === cand.toLowerCase());
      if (found) return found.path;
    }
    return 'Sent';
  } catch (err) {
    console.warn('Sent folder auto-detection fallback:', err.message);
    return 'Sent';
  }
}

/**
 * Utility: Format RFC 822 Raw Email Message
 */
async function buildRfc822Message({ fromName, fromEmail, toEmail, subject, bodyText, bodyHtml, inReplyTo, references }) {
  const mailOptions = {
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to: toEmail,
    subject: subject,
    text: bodyText || (bodyHtml || '').replace(/<[^>]+>/g, ''),
    html: bodyHtml || (bodyText || '').replace(/\n/g, '<br>')
  };
  if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
  if (references) mailOptions.references = references;

  const mail = new MailComposer(mailOptions);
  return await mail.compile().build();
}

/**
 * Utility: Call OpenRouter AI API
 */
function callOpenRouter(apiKey, messages, model = 'openai/gpt-4o-mini') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: 800,
      temperature: 0.7
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://emaildrafter.app',
        'X-Title': 'Cold Email Draft Generator'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          const content = parsed.choices?.[0]?.message?.content || '';
          resolve(content.trim());
        } catch (e) {
          reject(new Error('Failed to parse OpenRouter response: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

  if (accounts && Array.isArray(accounts)) {
    accounts.forEach(acc => { DB.upsertAccount(acc); });
  }

  const seenEmails = new Set();
  const uniqueLeads = [];
  leads.forEach(l => {
    const em = (l.email || '').trim().toLowerCase();
    if (em) {
      if (seenEmails.has(em)) return;
      seenEmails.add(em);
    }
    uniqueLeads.push(l);
  });

  const campaignId = 'camp_' + Date.now();
  const status = draftMode ? 'draft' : 'running';

  DB.createCampaign({
    id: campaignId,
    title: title || `Cold Email Campaign - ${new Date().toLocaleDateString()}`,
    status: status,
    template: template || {},
    valueProp: valueProp || '',
    senderName: senderName || '',
    leads: uniqueLeads
  });

  return res.status(201).json({
    success: true,
    campaignId: campaignId,
    status: status,
    message: 'Campaign stored in database with draft status'
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

  if (campaign.draft_breakdown && campaign.draft_breakdown.length > 0 && !force) {
    return res.json({
      success: true,
      message: 'Drafts already generated for this campaign',
      summary: campaign.draft_breakdown
    });
  }

  let accounts = imapCredentials && imapCredentials.length > 0 ? imapCredentials : DB.getAllAccounts();
  if (!accounts || accounts.length === 0) {
    return res.status(400).json({ error: 'No IMAP sender accounts configured.' });
  }

  accounts.forEach(acc => DB.upsertAccount(acc));

  const summary = [];
  const warnings = [];

  const accountLeadMap = new Map();
  accounts.forEach((acc) => {
    const accId = DB.upsertAccount(acc);
    accountLeadMap.set(accId, { account: acc, accountId: accId, leads: [] });
  });

  const accList = Array.from(accountLeadMap.keys());
  campaign.leads.forEach((lead, i) => {
    const targetAccId = accList[i % accList.length];
    accountLeadMap.get(targetAccId).leads.push(lead);
  });

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
      host, port, secure: true,
      auth: { user, pass },
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

        let subject = (campaign.template && campaign.template.subject) ? campaign.template.subject : 'Quick idea for {{company_name}}';
        let body = (campaign.template && campaign.template.body) ? campaign.template.body : 'Hi {{first_name}},\n\nNoticed {{company_name}} has been {{trigger}}.\n\n{{value_prop}}\n\nBest,\n{{sender_name}}';

        Object.keys(context).forEach(k => {
          const regex = new RegExp(`{{\\s*${k}\\s*}}`, 'gi');
          subject = subject.replace(regex, context[k] !== undefined ? context[k] : '');
          body = body.replace(regex, context[k] !== undefined ? context[k] : '');
        });

        const rawMime = await buildRfc822Message({
          fromName: campaign.sender_name || user.split('@')[0],
          fromEmail: user,
          toEmail: lead.email,
          subject,
          bodyText: body,
          bodyHtml: body.replace(/\n/g, '<br>')
        });

        await client.append(draftsFolder, rawMime, ['\\Draft']);
        draftsAdded++;
        DB.updateLeadDraftAccount(lead.id, accId);
      }

      await client.logout();
      summary.push({ accountId: accId, email: user, draftsAdded, draftsFolder, status: 'success' });

    } catch (err) {
      console.error(`IMAP Draft Error for ${user}:`, err.message);
      warnings.push(`IMAP connection failed for ${user}: ${err.message}`);
      summary.push({ accountId: accId, email: user, draftsAdded, status: 'failed', error: err.message });
    }
  }

  DB.updateCampaignDraftBreakdown(id, summary);

  return res.json({
    success: true,
    message: `Generated drafts for ${summary.reduce((a, b) => a + b.draftsAdded, 0)} leads across IMAP accounts.`,
    summary,
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
  if (!campaign) return res.status(404).json({ error: 'Campaign not found in database' });
  DB.updateCampaignStatus(id, 'running');
  return res.json({
    success: true,
    message: 'Campaign updated from draft to running status.',
    campaign: { id: campaign.id, status: 'running', draft_breakdown: campaign.draft_breakdown }
  });
});

// ==========================================
// 4. Get Campaign Details
// GET /api/campaigns/:id
// ==========================================
app.get('/api/campaigns/:id', (req, res) => {
  const campaign = DB.getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found in database' });
  return res.json({ success: true, campaign });
});

// ==========================================
// 5. AI Follow-Up Engine
// POST /api/followups/scan
// ==========================================
app.post('/api/followups/scan', async (req, res) => {
  const {
    imapCredentials = [],
    followUpDelayDays = 3,
    maxEmailsPerAccount = 50,
    openRouterApiKey
  } = req.body;

  if (!openRouterApiKey) {
    return res.status(400).json({ error: 'OpenRouter API key is required.' });
  }

  let accounts = imapCredentials.length > 0 ? imapCredentials : DB.getAllAccounts();
  if (!accounts || accounts.length === 0) {
    return res.status(400).json({ error: 'No sender accounts configured.' });
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - followUpDelayDays);

  const results = [];
  const globalWarnings = [];

  for (const account of accounts) {
    const user = account.user || account.email;
    const pass = account.password || account.appPassword;
    const host = account.host || 'imap.gmail.com';
    const port = account.port || 993;

    const accountResult = {
      email: user,
      emailsScanned: 0,
      coldEmailsFound: 0,
      followUpsDrafted: 0,
      skipped: 0,
      errors: []
    };

    if (!pass) {
      accountResult.errors.push('No app password configured — skipped.');
      results.push(accountResult);
      continue;
    }

    const client = new ImapFlow({
      host, port, secure: true,
      auth: { user, pass },
      logger: false
    });

    try {
      await client.connect();

      // Detect Sent & Drafts folders
      const sentFolder = await detectSentMailbox(client);
      const draftsFolder = await detectDraftsMailbox(client);

      // Open Sent folder
      await client.mailboxOpen(sentFolder, { readOnly: true });

      // Search for messages older than delay cutoff
      const sinceDate = cutoffDate;
      let uids;
      try {
        uids = await client.search({ before: new Date(), since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });
      } catch (e) {
        uids = await client.search({ all: true });
      }

      // Limit to most recent N emails
      const limitedUids = uids.slice(-maxEmailsPerAccount);
      accountResult.emailsScanned = limitedUids.length;

      for (const uid of limitedUids) {
        try {
          // Fetch headers
          const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true, bodyParts: ['TEXT'] });
          if (!msg || !msg.envelope) continue;

          const envelope = msg.envelope;
          const sentDate = envelope.date ? new Date(envelope.date) : null;

          // Skip if sent too recently
          if (sentDate && sentDate > cutoffDate) {
            accountResult.skipped++;
            continue;
          }

          const toEmail = envelope.to?.[0]?.address || '';
          const subject = envelope.subject || '';
          const messageId = envelope.messageId || uid.toString();

          // Skip if we already drafted a follow-up for this email
          if (DB.wasFollowupSent(user, messageId)) {
            accountResult.skipped++;
            continue;
          }

          // Fetch text body
          let bodyText = '';
          try {
            const bodyMsg = await client.fetchOne(uid, { bodyParts: ['1', 'TEXT'] });
            const parts = bodyMsg?.bodyParts;
            if (parts) {
              const part = parts.get('1') || parts.get('TEXT') || parts.values().next().value;
              if (part) bodyText = part.toString().slice(0, 1500);
            }
          } catch (e) { /* body fetch optional */ }

          // === STEP 1: AI Cold Email Classification ===
          let isColdEmail = false;
          try {
            const classifyPrompt = `You are an email classifier. Analyze this sent email and determine if it is a cold outreach/prospecting email (an unsolicited first-contact email to a potential client, partner, or sales prospect).

Subject: ${subject}
To: ${toEmail}
Body excerpt: ${bodyText || '(body not available)'}

Reply with ONLY "YES" if this is a cold outreach email, or "NO" if it is not (e.g., reply, newsletter, internal email, transactional, etc.).`;

            const classifyResponse = await callOpenRouter(openRouterApiKey, [
              { role: 'user', content: classifyPrompt }
            ]);
            isColdEmail = classifyResponse.toUpperCase().startsWith('YES');
          } catch (aiErr) {
            accountResult.errors.push(`AI classify error for msg ${uid}: ${aiErr.message}`);
            continue;
          }

          if (!isColdEmail) continue;
          accountResult.coldEmailsFound++;

          // === STEP 2: AI Follow-Up Generation ===
          let followUpSubject = `Re: ${subject}`;
          let followUpBody = '';
          try {
            const generatePrompt = `You are an expert cold email copywriter. Write a short, friendly follow-up email for the original cold email below.

Guidelines:
- Keep it under 80 words
- Be casual, not pushy
- Reference that you sent them something previously
- End with a simple, low-friction call to action
- Do NOT use placeholders like [Name] — write naturally
- Output ONLY the email body text, no subject line

Original email sent to: ${toEmail}
Original subject: ${subject}
Original body: ${bodyText || '(not available)'}`;

            followUpBody = await callOpenRouter(openRouterApiKey, [
              { role: 'user', content: generatePrompt }
            ]);
          } catch (aiErr) {
            accountResult.errors.push(`AI generate error for msg ${uid}: ${aiErr.message}`);
            continue;
          }

          // === STEP 3: Append Follow-Up to Drafts ===
          try {
            await client.mailboxOpen(draftsFolder);
            const rawMime = await buildRfc822Message({
              fromName: user.split('@')[0],
              fromEmail: user,
              toEmail,
              subject: followUpSubject,
              bodyText: followUpBody,
              bodyHtml: followUpBody.replace(/\n/g, '<br>'),
              inReplyTo: messageId,
              references: messageId
            });

            await client.append(draftsFolder, rawMime, ['\\Draft']);
            accountResult.followUpsDrafted++;

            // Persist to DB to prevent duplicates
            DB.saveFollowup({
              fromAccount: user,
              toEmail,
              originalSubject: subject,
              originalMessageId: messageId,
              followUpSubject,
              followUpBody
            });

            // Re-open sent folder for next iteration
            await client.mailboxOpen(sentFolder, { readOnly: true });
          } catch (appendErr) {
            accountResult.errors.push(`Draft append error for msg ${uid}: ${appendErr.message}`);
          }

        } catch (msgErr) {
          accountResult.errors.push(`Error processing uid ${uid}: ${msgErr.message}`);
        }
      }

      await client.logout();

    } catch (connErr) {
      accountResult.errors.push(`IMAP connection failed: ${connErr.message}`);
    }

    results.push(accountResult);
  }

  const totalScanned = results.reduce((a, r) => a + r.emailsScanned, 0);
  const totalCold = results.reduce((a, r) => a + r.coldEmailsFound, 0);
  const totalDrafted = results.reduce((a, r) => a + r.followUpsDrafted, 0);

  return res.json({
    success: true,
    message: `Scanned ${totalScanned} sent emails. Found ${totalCold} cold emails. Drafted ${totalDrafted} follow-ups.`,
    summary: { totalScanned, totalCold, totalDrafted, followUpDelayDays },
    accountResults: results,
    warnings: globalWarnings.length > 0 ? globalWarnings : undefined
  });
});

// ==========================================
// 6. Get All Follow-Ups
// GET /api/followups
// ==========================================
app.get('/api/followups', (req, res) => {
  return res.json({ success: true, followups: DB.getAllFollowups() });
});

// Export Express App for Vercel Serverless Function deployment
module.exports = app;

// Start local listener if run directly (not required by Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 IMAP Draft Engine + AI Follow-Up API Server running at http://localhost:${PORT}`);
  });
}
