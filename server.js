/**
 * IMAP Draft Engine Server (Node.js + Express + ImapFlow)
 * Appends RFC 822 formatted cold email drafts into Gmail / Outlook IMAP Drafts folders.
 * Includes AI Follow-Up Engine (3-Step Sequence) via OpenRouter API.
 *
 * Follow-Up Sequence:
 *   Step 1: 1 day  after original cold email sent
 *   Step 2: 3 days after step 1 draft created
 *   Step 3: 5 days after step 2 draft created
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

// ─────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────

async function detectDraftsMailbox(client) {
  try {
    const mailboxes = await client.list();
    for (const box of mailboxes) {
      if (box.flags && (box.flags.has('\\Drafts') || box.specialUse === '\\Drafts')) return box.path;
    }
    for (const cand of ['[Gmail]/Drafts', 'Drafts', 'INBOX.Drafts', 'Draft']) {
      const found = mailboxes.find(m => m.path.toLowerCase() === cand.toLowerCase());
      if (found) return found.path;
    }
    return 'Drafts';
  } catch (err) {
    return 'Drafts';
  }
}

async function detectSentMailbox(client) {
  try {
    const mailboxes = await client.list();
    for (const box of mailboxes) {
      if (box.flags && (box.flags.has('\\Sent') || box.specialUse === '\\Sent')) return box.path;
    }
    for (const cand of ['[Gmail]/Sent Mail', 'Sent', 'Sent Items', 'INBOX.Sent']) {
      const found = mailboxes.find(m => m.path.toLowerCase() === cand.toLowerCase());
      if (found) return found.path;
    }
    return 'Sent';
  } catch (err) {
    return 'Sent';
  }
}

async function buildRfc822Message({ fromName, fromEmail, toEmail, subject, bodyText, bodyHtml, inReplyTo, references }) {
  const opts = {
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to: toEmail,
    subject,
    text: bodyText || (bodyHtml || '').replace(/<[^>]+>/g, ''),
    html: bodyHtml || (bodyText || '').replace(/\n/g, '<br>')
  };
  if (inReplyTo) opts.inReplyTo = inReplyTo;
  if (references) opts.references = references;
  const mail = new MailComposer(opts);
  return await mail.compile().build();
}

function callOpenRouter(apiKey, messages, model = 'openai/gpt-4o-mini') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, max_tokens: 800, temperature: 0.7 });
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
          resolve((parsed.choices?.[0]?.message?.content || '').trim());
        } catch (e) {
          reject(new Error('Failed to parse OpenRouter response: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────
// 1. Create Draft Campaign
// POST /api/campaigns
// ─────────────────────────────────────────
app.post('/api/campaigns', (req, res) => {
  const { title, accounts, leads, template, valueProp, senderName, draftMode = true } = req.body;

  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'Leads array is required' });
  }

  if (accounts && Array.isArray(accounts)) {
    accounts.forEach(acc => DB.upsertAccount(acc));
  }

  const seenEmails = new Set();
  const uniqueLeads = [];
  leads.forEach(l => {
    const em = (l.email || '').trim().toLowerCase();
    if (em && seenEmails.has(em)) return;
    if (em) seenEmails.add(em);
    uniqueLeads.push(l);
  });

  const campaignId = 'camp_' + Date.now();
  const status = draftMode ? 'draft' : 'running';

  DB.createCampaign({
    id: campaignId,
    title: title || `Cold Email Campaign - ${new Date().toLocaleDateString()}`,
    status,
    template: template || {},
    valueProp: valueProp || '',
    senderName: senderName || '',
    leads: uniqueLeads
  });

  return res.status(201).json({ success: true, campaignId, status, message: 'Campaign stored.' });
});

// ─────────────────────────────────────────
// 2. Save Drafts to IMAP
// POST /api/campaigns/:id/save-drafts
// ─────────────────────────────────────────
app.post('/api/campaigns/:id/save-drafts', async (req, res) => {
  const { id } = req.params;
  const { force = false, imapCredentials = [] } = req.body;

  const campaign = DB.getCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'draft' && !force) return res.status(400).json({ error: `Campaign status is ${campaign.status}` });
  if (campaign.draft_breakdown && campaign.draft_breakdown.length > 0 && !force) {
    return res.json({ success: true, message: 'Drafts already generated', summary: campaign.draft_breakdown });
  }

  let accounts = imapCredentials.length > 0 ? imapCredentials : DB.getAllAccounts();
  if (!accounts || accounts.length === 0) return res.status(400).json({ error: 'No IMAP accounts configured.' });

  accounts.forEach(acc => DB.upsertAccount(acc));

  const summary = [];
  const warnings = [];

  const accountLeadMap = new Map();
  accounts.forEach(acc => {
    const accId = DB.upsertAccount(acc);
    accountLeadMap.set(accId, { account: acc, accountId: accId, leads: [] });
  });

  const accList = Array.from(accountLeadMap.keys());
  campaign.leads.forEach((lead, i) => {
    accountLeadMap.get(accList[i % accList.length]).leads.push(lead);
  });

  for (const [accId, { account, leads }] of accountLeadMap.entries()) {
    if (leads.length === 0) continue;
    const user = account.user || account.email;
    const pass = account.password || account.appPassword;
    const host = account.host || 'imap.gmail.com';
    const port = account.port || 993;

    if (!pass) {
      warnings.push(`${user} skipped: no password.`);
      summary.push({ accountId: accId, email: user, draftsAdded: 0, status: 'failed_missing_password' });
      continue;
    }

    const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
    let draftsAdded = 0;

    try {
      await client.connect();
      const draftsFolder = await detectDraftsMailbox(client);

      for (const lead of leads) {
        const ctx = {
          first_name: lead.first_name || lead.firstName || 'there',
          company_name: lead.company_name || lead.company || 'your team',
          email: lead.email || '',
          trigger: lead.trigger_note || lead.trigger || 'doing great work',
          value_prop: campaign.value_prop || '',
          sender_name: campaign.sender_name || account.senderName || user
        };

        let subject = campaign.template?.subject || 'Quick idea for {{company_name}}';
        let body = campaign.template?.body || 'Hi {{first_name}},\n\nNoticed {{company_name}} has been {{trigger}}.\n\n{{value_prop}}\n\nBest,\n{{sender_name}}';

        Object.keys(ctx).forEach(k => {
          const rx = new RegExp(`{{\\s*${k}\\s*}}`, 'gi');
          subject = subject.replace(rx, ctx[k] ?? '');
          body = body.replace(rx, ctx[k] ?? '');
        });

        const rawMime = await buildRfc822Message({
          fromName: campaign.sender_name || user.split('@')[0],
          fromEmail: user, toEmail: lead.email, subject,
          bodyText: body, bodyHtml: body.replace(/\n/g, '<br>')
        });

        await client.append(draftsFolder, rawMime, ['\\Draft']);
        draftsAdded++;
        DB.updateLeadDraftAccount(lead.id, accId);
      }

      await client.logout();
      summary.push({ accountId: accId, email: user, draftsAdded, draftsFolder, status: 'success' });
    } catch (err) {
      warnings.push(`${user}: ${err.message}`);
      summary.push({ accountId: accId, email: user, draftsAdded, status: 'failed', error: err.message });
    }
  }

  DB.updateCampaignDraftBreakdown(id, summary);
  return res.json({
    success: true,
    message: `Generated ${summary.reduce((a, b) => a + b.draftsAdded, 0)} drafts.`,
    summary,
    warnings: warnings.length > 0 ? warnings : undefined
  });
});

// ─────────────────────────────────────────
// 3. Launch Campaign
// POST /api/campaigns/:id/launch-draft
// ─────────────────────────────────────────
app.post('/api/campaigns/:id/launch-draft', (req, res) => {
  const campaign = DB.getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  DB.updateCampaignStatus(req.params.id, 'running');
  return res.json({ success: true, campaign: { id: campaign.id, status: 'running', draft_breakdown: campaign.draft_breakdown } });
});

// ─────────────────────────────────────────
// 4. Get Campaign
// GET /api/campaigns/:id
// ─────────────────────────────────────────
app.get('/api/campaigns/:id', (req, res) => {
  const campaign = DB.getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  return res.json({ success: true, campaign });
});

// ─────────────────────────────────────────
// 5. AI Follow-Up Engine — 3-Step Sequence
// POST /api/followups/scan
//
// Step 1 → 1 day  after original cold email sent
// Step 2 → 3 days after step 1 drafted
// Step 3 → 5 days after step 2 drafted
// ─────────────────────────────────────────
app.post('/api/followups/scan', async (req, res) => {
  const { imapCredentials = [], maxEmailsPerAccount = 50, openRouterApiKey } = req.body;

  if (!openRouterApiKey) return res.status(400).json({ error: 'OpenRouter API key is required.' });

  // days to wait since the PREVIOUS event before triggering each step
  const STEP_DELAYS = { 1: 1, 2: 3, 3: 5 };
  const MAX_STEPS = 3;

  let accounts = imapCredentials.length > 0 ? imapCredentials : DB.getAllAccounts();
  if (!accounts || accounts.length === 0) return res.status(400).json({ error: 'No sender accounts configured.' });

  const now = new Date();
  const daysSince = d => d ? (now - new Date(d)) / 86400000 : 0;

  const stepPrompts = {
    1: (subject, body) =>
      `You are an expert cold email copywriter. Write a short, casual FIRST follow-up (under 60 words) to a cold email that received no reply. Be friendly and brief — just checking in. Output ONLY the email body, no subject line.\n\nOriginal subject: ${subject}\nOriginal body excerpt: ${body || '(unavailable)'}`,

    2: (subject) =>
      `Write a SECOND follow-up email (under 70 words) for a cold email that still has no reply. Add a short, compelling value point. Be conversational, not pushy. Output ONLY the email body, no subject line.\n\nOriginal subject: ${subject}`,

    3: (subject) =>
      `Write a SHORT, polite "final attempt" breakup email (under 50 words). This is the last follow-up in the sequence. Leave the door open. No hard sell. Output ONLY the email body, no subject line.\n\nOriginal subject: ${subject}`
  };

  const stepSubject = {
    1: s => `Re: ${s}`,
    2: s => `Re: ${s}`,
    3: s => `[Last note] ${s}`
  };

  const results = [];

  for (const account of accounts) {
    const user = account.user || account.email;
    const pass = account.password || account.appPassword;
    const host = account.host || 'imap.gmail.com';
    const port = account.port || 993;

    const ar = { email: user, emailsScanned: 0, coldEmailsFound: 0, step1Drafted: 0, step2Drafted: 0, step3Drafted: 0, skipped: 0, errors: [] };

    if (!pass) { ar.errors.push('No app password — skipped.'); results.push(ar); continue; }

    const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });

    try {
      await client.connect();
      const sentFolder  = await detectSentMailbox(client);
      const draftsFolder = await detectDraftsMailbox(client);

      await client.mailboxOpen(sentFolder, { readOnly: true });

      let uids;
      try {
        uids = await client.search({ since: new Date(Date.now() - 30 * 86400000) });
      } catch {
        uids = await client.search({ all: true });
      }

      const limited = uids.slice(-maxEmailsPerAccount);
      ar.emailsScanned = limited.length;

      for (const uid of limited) {
        try {
          const msg = await client.fetchOne(uid, { envelope: true });
          if (!msg?.envelope) continue;

          const { envelope } = msg;
          const sentDate  = envelope.date ? new Date(envelope.date) : null;
          const toEmail   = envelope.to?.[0]?.address || '';
          const subject   = envelope.subject || '';
          const messageId = envelope.messageId || String(uid);

          // Determine current follow-up step for this email
          const fuState    = DB.getFollowupState(user, messageId);
          const currentStep = fuState ? fuState.step : 0;

          if (currentStep >= MAX_STEPS) { ar.skipped++; continue; }

          const nextStep = currentStep + 1;

          // Check delay condition
          let ready = false;
          if (nextStep === 1) {
            ready = sentDate && daysSince(sentDate) >= STEP_DELAYS[1];
          } else {
            ready = fuState && daysSince(fuState.lastFollowupAt) >= STEP_DELAYS[nextStep];
          }

          if (!ready) { ar.skipped++; continue; }

          // Step 1 only: classify with AI to confirm it's a cold email
          let bodyText = '';
          if (nextStep === 1) {
            try {
              const bm = await client.fetchOne(uid, { bodyParts: ['1', 'TEXT'] });
              const parts = bm?.bodyParts;
              if (parts) {
                const part = parts.get('1') || parts.get('TEXT') || parts.values().next().value;
                if (part) bodyText = part.toString().slice(0, 1000);
              }
            } catch { /* body optional */ }

            let isCold = false;
            try {
              const resp = await callOpenRouter(openRouterApiKey, [{
                role: 'user',
                content: `Is this a cold outreach/prospecting email? Reply ONLY "YES" or "NO".\n\nSubject: ${subject}\nTo: ${toEmail}\nBody: ${bodyText || '(unavailable)'}`
              }]);
              isCold = resp.toUpperCase().startsWith('YES');
            } catch (e) {
              ar.errors.push(`AI classify uid ${uid}: ${e.message}`);
              continue;
            }

            if (!isCold) { ar.skipped++; continue; }
            ar.coldEmailsFound++;
          }

          // Generate follow-up body
          let followUpBody = '';
          try {
            followUpBody = await callOpenRouter(openRouterApiKey, [{
              role: 'user',
              content: stepPrompts[nextStep](subject, bodyText)
            }]);
          } catch (e) {
            ar.errors.push(`AI generate step ${nextStep} uid ${uid}: ${e.message}`);
            continue;
          }

          const followUpSubject = stepSubject[nextStep](subject);

          // Append to Drafts
          try {
            await client.mailboxOpen(draftsFolder);
            const rawMime = await buildRfc822Message({
              fromName: user.split('@')[0], fromEmail: user, toEmail,
              subject: followUpSubject,
              bodyText: followUpBody,
              bodyHtml: followUpBody.replace(/\n/g, '<br>'),
              inReplyTo: messageId, references: messageId
            });
            await client.append(draftsFolder, rawMime, ['\\Draft']);

            DB.saveFollowup({
              fromAccount: user, toEmail,
              originalSubject: subject, originalMessageId: messageId,
              followUpSubject, followUpBody, step: nextStep
            });

            if (nextStep === 1) ar.step1Drafted++;
            if (nextStep === 2) ar.step2Drafted++;
            if (nextStep === 3) ar.step3Drafted++;

            // Re-open Sent for next loop iteration
            await client.mailboxOpen(sentFolder, { readOnly: true });
          } catch (e) {
            ar.errors.push(`Append error step ${nextStep} uid ${uid}: ${e.message}`);
          }

        } catch (e) {
          ar.errors.push(`Msg error uid ${uid}: ${e.message}`);
        }
      }

      await client.logout();
    } catch (e) {
      ar.errors.push(`IMAP connect failed: ${e.message}`);
    }

    results.push(ar);
  }

  const totalScanned = results.reduce((a, r) => a + r.emailsScanned, 0);
  const totalCold    = results.reduce((a, r) => a + r.coldEmailsFound, 0);
  const totalStep1   = results.reduce((a, r) => a + r.step1Drafted, 0);
  const totalStep2   = results.reduce((a, r) => a + r.step2Drafted, 0);
  const totalStep3   = results.reduce((a, r) => a + r.step3Drafted, 0);

  return res.json({
    success: true,
    message: `Scanned ${totalScanned} emails. ${totalCold} cold found. Drafted: ${totalStep1}+${totalStep2}+${totalStep3} follow-ups (step 1+2+3).`,
    summary: { totalScanned, totalCold, totalDrafted: totalStep1 + totalStep2 + totalStep3, totalStep1, totalStep2, totalStep3 },
    sequence: { step1Days: 1, step2Days: 3, step3Days: 5 },
    accountResults: results
  });
});

// ─────────────────────────────────────────
// 6. Get All Follow-Ups
// GET /api/followups
// ─────────────────────────────────────────
app.get('/api/followups', (req, res) => {
  return res.json({ success: true, followups: DB.getAllFollowups() });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 IMAP Draft Engine + AI Follow-Up Server on http://localhost:${PORT}`);
  });
}
