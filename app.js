/**
 * Cold Email Campaign Generator & IMAP Draft Engine
 * Multi-Account Round-Robin Draft Distribution (100% Client-Side + Local Node IMAP Engine)
 */

(function () {
  'use strict';

  // API Backend Config (Served unified on same origin /api)
  const API_BASE_URL = '/api';

  // State Management
  const state = {
    accounts: [], // Array of { id, email, password, host, port }
    csvText: '',
    parsedContacts: [],
    headers: [],
    drafts: [],
    activeInput: null,
    activeFilter: 'ALL',
    currentCampaignId: null
  };

  // DOM Element Selectors
  const DOM = {
    // Accounts
    accountEmailInput: document.getElementById('account-email-input'),
    accountPassInput: document.getElementById('account-pass-input'),
    addAccountBtn: document.getElementById('add-account-btn'),
    accountsTagsList: document.getElementById('accounts-tags-list'),
    accountsCount: document.getElementById('accounts-count'),
    loadPresetAccountsBtn: document.getElementById('load-preset-accounts-btn'),

    // Global Config
    valuePropInput: document.getElementById('value-prop-input'),
    senderNameInput: document.getElementById('sender-name-input'),

    // CSV
    csvInput: document.getElementById('csv-input'),
    csvFileInput: document.getElementById('csv-file-input'),
    loadSampleBtn: document.getElementById('load-sample-btn'),
    csvStatusBadge: document.getElementById('csv-status-badge'),
    csvMetrics: document.getElementById('csv-metrics'),

    // Template Editor
    tagsBar: document.getElementById('tags-bar'),
    templateSubject: document.getElementById('template-subject'),
    templateBody: document.getElementById('template-body'),
    resetTemplateBtn: document.getElementById('reset-template-btn'),

    // Actions & Output
    generateBtn: document.getElementById('generate-btn'),
    saveImapDraftsBtn: document.getElementById('save-imap-drafts-btn'),
    imapBreakdownCard: document.getElementById('imap-breakdown-card'),
    campaignStatusBadge: document.getElementById('campaign-status-badge'),
    launchCampaignBtn: document.getElementById('launch-campaign-btn'),
    breakdownList: document.getElementById('breakdown-list'),

    outputSection: document.getElementById('output-section'),
    draftsCountText: document.getElementById('drafts-count-text'),
    accountFilterTabs: document.getElementById('account-filter-tabs'),
    draftsList: document.getElementById('drafts-list'),
    copyVisibleBtn: document.getElementById('copy-visible-btn'),
    copyAllBtn: document.getElementById('copy-all-btn'),
    toastContainer: document.getElementById('toast-container')
  };

  // Default Template
  const DEFAULT_TEMPLATE = {
    subject: 'Quick idea for {{company_name}}',
    body: `Hi {{first_name}},

Noticed {{company_name}} has been {{trigger}}.

{{value_prop}}

Worth a quick 15-min call to see if it's a fit?

Best,
{{sender_name}}`
  };

  // Sample CSV Data
  const SAMPLE_CSV = `first_name, company_name, email, trigger
Sarah, Acme Corp, sarah@acme.com, expanding into the EMEA region
David, TechFlow, david@techflow.io, recent Series B funding announcement
Elena, Nexus AI, elena@nexus.ai, launching a new developer platform
Marcus, CloudScale, marcus@cloudscale.net, scaling the engineering leadership team
Jessica, Vantage Labs, jessica@vantage.co, opening a new Austin headquarters
Liam, Pulse Metrics, liam@pulse.io, featured on TechCrunch startup showcase`;

  // Sample Gmail Accounts
  const SAMPLE_ACCOUNTS = [
    { email: 'alex.morgan@gmail.com', password: '' },
    { email: 'outreach.alex@gmail.com', password: '' },
    { email: 'sales.alex@gmail.com', password: '' }
  ];

  // Initialize App
  function init() {
    loadSavedAccounts();
    setupEventListeners();
    trackFocusedInput();

    // Auto load sample CSV on first launch if empty
    if (!DOM.csvInput.value.trim()) {
      DOM.csvInput.value = SAMPLE_CSV;
      handleCSVUpdate();
    }
  }

  // --- ACCOUNTS MANAGEMENT ---
  function normalizeAccount(acc) {
    if (typeof acc === 'string') {
      return {
        email: acc.trim(),
        password: '',
        host: acc.endsWith('@gmail.com') ? 'imap.gmail.com' : 'imap.mail.yahoo.com',
        port: 993
      };
    }
    const email = (acc.email || acc.id || '').trim();
    return {
      email: email,
      password: (acc.password || '').trim(),
      host: acc.host || (email.endsWith('@gmail.com') ? 'imap.gmail.com' : 'imap.mail.yahoo.com'),
      port: acc.port || 993
    };
  }

  function loadSavedAccounts() {
    try {
      const saved = localStorage.getItem('cold_email_imap_accounts') || localStorage.getItem('cold_email_accounts');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          state.accounts = parsed.map(normalizeAccount).filter(a => a.email.length > 0);
        }
      }
    } catch (e) {
      console.error('Failed to load accounts from localStorage', e);
    }

    if (!state.accounts || state.accounts.length === 0) {
      state.accounts = SAMPLE_ACCOUNTS.map(normalizeAccount);
    }
    renderAccounts();
  }

  function saveAccounts() {
    try {
      localStorage.setItem('cold_email_imap_accounts', JSON.stringify(state.accounts));
    } catch (e) {
      console.error('Failed to save accounts', e);
    }
    renderAccounts();
  }

  function addAccount(emailVal, passVal) {
    const emailEl = document.getElementById('account-email-input');
    const passEl = document.getElementById('account-pass-input');

    const cleanEmail = (emailVal !== undefined ? emailVal : (emailEl ? emailEl.value : '')).trim();
    const cleanPass = (passVal !== undefined ? passVal : (passEl ? passEl.value : '')).trim();

    if (!cleanEmail) {
      showToast('Please enter an email address.', 'info');
      return;
    }

    const existingIdx = state.accounts.findIndex(a => a.email.toLowerCase() === cleanEmail.toLowerCase());
    if (existingIdx >= 0) {
      state.accounts[existingIdx].password = cleanPass;
      showToast(`Updated password for ${cleanEmail}`, 'info');
    } else {
      state.accounts.push({
        email: cleanEmail,
        password: cleanPass,
        host: cleanEmail.toLowerCase().endsWith('@gmail.com') ? 'imap.gmail.com' : 'imap.mail.yahoo.com',
        port: 993
      });
      showToast(`Added account ${cleanEmail}`, 'success');
    }

    if (emailEl) emailEl.value = '';
    if (passEl) passEl.value = '';
    saveAccounts();
  }

  function removeAccount(index) {
    const removed = state.accounts.splice(index, 1);
    saveAccounts();
    if (removed.length > 0) {
      showToast(`Removed ${removed[0].email}`, 'info');
    }
  }

  function renderAccounts() {
    const countEl = document.getElementById('accounts-count') || DOM.accountsCount;
    const listEl = document.getElementById('accounts-tags-list') || DOM.accountsTagsList;

    if (countEl) countEl.textContent = state.accounts.length;
    if (!listEl) return;

    listEl.innerHTML = '';

    if (state.accounts.length === 0) {
      listEl.innerHTML = `<span class="helper-text">No accounts added. Please add at least 1 sender account above.</span>`;
      return;
    }

    state.accounts.forEach((acc, idx) => {
      const chip = document.createElement('div');
      chip.className = 'account-chip';
      chip.innerHTML = `
        <span>✉ ${escapeHTML(acc.email)} ${acc.password ? '🔑' : '⚠️ No pass'}</span>
        <button class="remove-account-btn" type="button" title="Remove account">&times;</button>
      `;
      chip.querySelector('.remove-account-btn').addEventListener('click', () => removeAccount(idx));
      listEl.appendChild(chip);
    });
  }

  // --- CSV PARSER ---
  function parseCSV(text) {
    const lines = [];
    let curLine = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          curLine += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        lines.push(curLine);
        curLine = '';
      } else {
        curLine += char;
      }
    }
    if (curLine) lines.push(curLine);

    const validLines = lines.filter(l => l.trim().length > 0);
    if (validLines.length === 0) {
      return { headers: [], rows: [] };
    }

    const headers = parseCSVLine(validLines[0]).map(h => h.trim());
    const rows = [];
    for (let i = 1; i < validLines.length; i++) {
      const fields = parseCSVLine(validLines[i]);
      const rowObj = {};
      headers.forEach((h, idx) => {
        const key = h.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        rowObj[key] = fields[idx] !== undefined ? fields[idx].trim() : '';
        rowObj[h] = fields[idx] !== undefined ? fields[idx].trim() : '';
      });
      rows.push(rowObj);
    }

    return { headers, rows };
  }

  function parseCSVLine(line) {
    const fields = [];
    let curField = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          curField += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        fields.push(curField);
        curField = '';
      } else {
        curField += char;
      }
    }
    fields.push(curField);
    return fields;
  }

  // --- CSV EVENT HANDLING & DYNAMIC TAGS ---
  function handleCSVUpdate() {
    const text = DOM.csvInput.value;
    state.csvText = text;

    const { headers, rows } = parseCSV(text);
    state.headers = headers;
    state.parsedContacts = rows;

    if (rows.length > 0) {
      DOM.csvStatusBadge.textContent = `✓ ${rows.length} Contacts Detected`;
      DOM.csvStatusBadge.className = 'status-badge active';
      DOM.csvMetrics.textContent = `${rows.length} contacts (${headers.length} columns)`;
    } else {
      DOM.csvStatusBadge.textContent = 'Awaiting CSV';
      DOM.csvStatusBadge.className = 'status-badge muted';
      DOM.csvMetrics.textContent = '0 contacts detected';
    }

    updateDynamicTagPills(headers);
  }

  function updateDynamicTagPills(headers) {
    const standardTags = ['first_name', 'company_name', 'trigger', 'email'];
    const specialTags = ['assigned_account', 'value_prop', 'sender_name'];

    const allHeaderKeys = new Set(standardTags);
    headers.forEach(h => {
      const cleanKey = h.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (cleanKey) allHeaderKeys.add(cleanKey);
    });

    DOM.tagsBar.innerHTML = '';

    allHeaderKeys.forEach(tag => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'tag-pill';
      pill.dataset.tag = tag;
      pill.textContent = `{{${tag}}}`;
      pill.addEventListener('click', () => insertTag(`{{${tag}}}`));
      DOM.tagsBar.appendChild(pill);
    });

    specialTags.forEach(tag => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'tag-pill tag-pill-special';
      pill.dataset.tag = tag;
      pill.textContent = `{{${tag}}}`;
      pill.addEventListener('click', () => insertTag(`{{${tag}}}`));
      DOM.tagsBar.appendChild(pill);
    });
  }

  // --- TAG INSERTION ---
  function trackFocusedInput() {
    state.activeInput = DOM.templateBody;

    DOM.templateSubject.addEventListener('focus', () => {
      state.activeInput = DOM.templateSubject;
    });
    DOM.templateBody.addEventListener('focus', () => {
      state.activeInput = DOM.templateBody;
    });
  }

  function insertTag(tagString) {
    const target = state.activeInput || DOM.templateBody;
    target.focus();

    const start = target.selectionStart;
    const end = target.selectionEnd;
    const val = target.value;

    target.value = val.substring(0, start) + tagString + val.substring(end);
    target.selectionStart = target.selectionEnd = start + tagString.length;
    
    showToast(`Inserted ${tagString}`, 'info');
  }

  // --- DEDUPLICATION & METRICS ---
  function deduplicateRows(rows) {
    const seen = new Set();
    const unique = [];
    let dupCount = 0;

    rows.forEach(row => {
      const email = (getFieldValue(row, ['email', 'email_address', 'to']) || '').trim().toLowerCase();
      if (email) {
        if (seen.has(email)) {
          dupCount++;
          return; // Skip duplicate email
        }
        seen.add(email);
      }
      unique.push(row);
    });

    return { uniqueRows: unique, duplicateCount: dupCount };
  }

  function updateMetricsDisplay(uniqueCount, dupCount) {
    const totalLeadsEl = document.getElementById('metric-total-leads');
    const totalAccountsEl = document.getElementById('metric-total-accounts');
    const leadShareEl = document.getElementById('metric-lead-share');
    const duplicatesRemovedEl = document.getElementById('metric-duplicates-removed');

    const accCount = state.accounts.length || 1;
    const avgShare = uniqueCount > 0 ? (uniqueCount / accCount).toFixed(1) : '0';

    if (totalLeadsEl) totalLeadsEl.textContent = uniqueCount;
    if (totalAccountsEl) totalAccountsEl.textContent = state.accounts.length;
    if (leadShareEl) leadShareEl.textContent = `${avgShare}/acc`;
    if (duplicatesRemovedEl) duplicatesRemovedEl.textContent = dupCount;
  }

  // --- CLIENT-SIDE DRAFT GENERATION ---
  function generateCampaign() {
    const { rows } = parseCSV(DOM.csvInput.value);
    if (rows.length === 0) {
      showToast('Please paste or load CSV data before generating.', 'info');
      return;
    }

    if (state.accounts.length === 0) {
      showToast('Please add at least 1 sender account above.', 'info');
      return;
    }

    // Deduplicate leads by email
    const { uniqueRows, duplicateCount } = deduplicateRows(rows);

    updateMetricsDisplay(uniqueRows.length, duplicateCount);

    const valueProp = DOM.valuePropInput.value.trim();
    const senderName = DOM.senderNameInput.value.trim();
    const rawSubject = DOM.templateSubject.value;
    const rawBody = DOM.templateBody.value;

    const drafts = [];

    uniqueRows.forEach((row, idx) => {
      const assignedAccObj = state.accounts[idx % state.accounts.length];
      const assignedAccount = assignedAccObj.email;
      
      const firstName = getFieldValue(row, ['first_name', 'firstname', 'first', 'name']);
      const companyName = getFieldValue(row, ['company_name', 'company', 'organization', 'org']);
      const email = getFieldValue(row, ['email', 'email_address', 'to']);
      const trigger = getFieldValue(row, ['trigger', 'note', 'custom_note', 'reason']);

      const context = {
        first_name: firstName || 'there',
        company_name: companyName || 'your team',
        email: email || '',
        trigger: trigger || 'doing great work',
        assigned_account: assignedAccount,
        value_prop: valueProp,
        sender_name: senderName
      };

      Object.keys(row).forEach(k => {
        const keyClean = k.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (!context[keyClean]) {
          context[keyClean] = row[k];
        }
      });

      const filledSubject = fillTemplate(rawSubject, context);
      const filledBody = fillTemplate(rawBody, context);

      drafts.push({
        id: idx + 1,
        contactName: firstName ? `${firstName} (${companyName || 'Lead'})` : (companyName || email || `Lead #${idx + 1}`),
        contactEmail: email,
        companyName: companyName,
        subject: filledSubject,
        body: filledBody,
        assignedAccount: assignedAccount,
        accountIndex: idx % state.accounts.length
      });
    });

    state.drafts = drafts;
    state.activeFilter = 'ALL';

    renderCampaignResults();
    
    if (duplicateCount > 0) {
      showToast(`Generated ${drafts.length} drafts (${duplicateCount} duplicate email filtered)`, 'success');
    } else {
      showToast(`Generated ${drafts.length} drafts distributed equally across ${state.accounts.length} accounts!`, 'success');
    }
  }

  function getFieldValue(row, possibleKeys) {
    for (const key of possibleKeys) {
      if (row[key] !== undefined && row[key] !== '') {
        return row[key];
      }
    }
    return '';
  }

  function fillTemplate(template, context) {
    let result = template;
    Object.keys(context).forEach(key => {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
      result = result.replace(regex, context[key] || '');
    });
    return result;
  }

  // --- GMAIL LINK GENERATOR ---
  function buildGmailComposeUrl(toEmail, subject, body, accountEmail) {
    const encodedTo = encodeURIComponent(toEmail || '');
    const encodedSubject = encodeURIComponent(subject || '');
    const encodedBody = encodeURIComponent(body || '');
    const encodedAcc = encodeURIComponent(accountEmail || '');

    return `https://mail.google.com/mail/u/${encodedAcc}/?view=cm&fs=1&to=${encodedTo}&su=${encodedSubject}&body=${encodedBody}`;
  }

  // --- SAVE DRAFTS DIRECTLY TO REAL IMAP FOLDERS VIA BACKEND ---
  async function saveDraftsToIMAP() {
    const { rows } = parseCSV(DOM.csvInput.value);
    if (rows.length === 0) {
      showToast('Please paste or load CSV data.', 'info');
      return;
    }

    if (state.accounts.length === 0) {
      showToast('Please add at least 1 sender account.', 'info');
      return;
    }

    showToast('Saving emails to account Drafts folders via IMAP...', 'info');
    DOM.saveImapDraftsBtn.disabled = true;
    DOM.saveImapDraftsBtn.textContent = '⏳ Saving Drafts to IMAP...';

    try {
      // Step 1: Create Campaign
      const createRes = await fetch(`${API_BASE_URL}/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Campaign - ${new Date().toLocaleDateString()}`,
          accounts: state.accounts,
          leads: rows,
          template: {
            subject: DOM.templateSubject.value,
            body: DOM.templateBody.value
          },
          valueProp: DOM.valuePropInput.value,
          senderName: DOM.senderNameInput.value,
          draftMode: true
        })
      });

      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Failed to create campaign');

      state.currentCampaignId = createData.campaignId;

      // Step 2: Trigger IMAP Draft Appends
      const saveRes = await fetch(`${API_BASE_URL}/campaigns/${createData.campaignId}/save-drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          force: true,
          imapCredentials: state.accounts
        })
      });

      const saveData = await saveRes.json();
      if (!saveData.success) throw new Error(saveData.error || 'Failed to save IMAP drafts');

      // Also generate preview
      generateCampaign();

      // Render Breakdown Widget
      renderImapBreakdown(saveData.summary, rows.length);
      showToast(`Drafts created directly in IMAP mailboxes!`, 'success');

      if (saveData.warnings && saveData.warnings.length > 0) {
        showToast(saveData.warnings[0], 'info');
      }

    } catch (err) {
      console.error('IMAP Error:', err);
      showToast(`IMAP Engine Warning: ${err.message}`, 'info');
    } finally {
      DOM.saveImapDraftsBtn.disabled = false;
      DOM.saveImapDraftsBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
          <polyline points="17 21 17 13 7 13 7 21"></polyline>
          <polyline points="7 3 7 8 15 8"></polyline>
        </svg>
        Save Drafts to Real IMAP Folders`;
    }
  }

  // --- LAUNCH CAMPAIGN ---
  async function launchCampaign() {
    if (!state.currentCampaignId) {
      showToast('Please save drafts to IMAP first.', 'info');
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/campaigns/${state.currentCampaignId}/launch-draft`, {
        method: 'POST'
      });
      const data = await res.json();
      if (data.success) {
        DOM.campaignStatusBadge.textContent = 'Status: RUNNING';
        DOM.campaignStatusBadge.className = 'status-badge active';
        showToast('Campaign launched successfully!', 'success');
      }
    } catch (err) {
      showToast(`Failed to launch: ${err.message}`, 'info');
    }
  }

  // --- RENDER IMAP BREAKDOWN WIDGET ---
  function renderImapBreakdown(summary, totalLeads) {
    DOM.imapBreakdownCard.classList.remove('hidden');
    DOM.breakdownList.innerHTML = '';

    if (!summary || summary.length === 0) return;

    summary.forEach(item => {
      const pct = Math.round((item.draftsAdded / totalLeads) * 100) || 0;
      const el = document.createElement('div');
      el.className = 'breakdown-item';
      el.innerHTML = `
        <div class="breakdown-header">
          <span class="breakdown-email">✉ ${escapeHTML(item.email)}</span>
          <span class="breakdown-count">${item.draftsAdded} drafts (${pct}%)</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${pct}%"></div>
        </div>
      `;
      DOM.breakdownList.appendChild(el);
    });
  }

  // --- RENDER CAMPAIGN RESULTS ---
  function renderCampaignResults() {
    DOM.outputSection.classList.remove('hidden');
    DOM.outputSection.scrollIntoView({ behavior: 'smooth' });

    renderFilterTabs();
    renderDraftCards();
  }

  function renderFilterTabs() {
    DOM.accountFilterTabs.innerHTML = '';

    const allTab = document.createElement('button');
    allTab.className = `filter-tab ${state.activeFilter === 'ALL' ? 'active' : ''}`;
    allTab.innerHTML = `All Accounts <span class="badge">${state.drafts.length}</span>`;
    allTab.addEventListener('click', () => {
      state.activeFilter = 'ALL';
      renderFilterTabs();
      renderDraftCards();
    });
    DOM.accountFilterTabs.appendChild(allTab);

    state.accounts.forEach(acc => {
      const email = acc.email;
      const count = state.drafts.filter(d => d.assignedAccount === email).length;
      const tab = document.createElement('button');
      tab.className = `filter-tab ${state.activeFilter === email ? 'active' : ''}`;
      tab.innerHTML = `${escapeHTML(email)} <span class="badge">${count}</span>`;
      tab.addEventListener('click', () => {
        state.activeFilter = email;
        renderFilterTabs();
        renderDraftCards();
      });
      DOM.accountFilterTabs.appendChild(tab);
    });
  }

  function renderDraftCards() {
    DOM.draftsList.innerHTML = '';

    const visibleDrafts = state.activeFilter === 'ALL'
      ? state.drafts
      : state.drafts.filter(d => d.assignedAccount === state.activeFilter);

    DOM.draftsCountText.textContent = state.activeFilter === 'ALL'
      ? `${state.drafts.length} total drafts distributed across ${state.accounts.length} accounts`
      : `${visibleDrafts.length} drafts assigned to ${state.activeFilter}`;

    if (visibleDrafts.length === 0) {
      DOM.draftsList.innerHTML = `<div class="helper-text padding-md">No drafts found for this filter view.</div>`;
      return;
    }

    visibleDrafts.forEach((draft) => {
      const gmailUrl = buildGmailComposeUrl(draft.contactEmail, draft.subject, draft.body, draft.assignedAccount);

      const card = document.createElement('div');
      card.className = 'draft-card';
      card.innerHTML = `
        <div class="draft-header">
          <div class="contact-info">
            <span class="contact-name">${escapeHTML(draft.contactName)}</span>
            ${draft.contactEmail ? `<span class="contact-email">${escapeHTML(draft.contactEmail)}</span>` : ''}
          </div>
          <div class="draft-account-badge" title="Draft assigned to this sender inbox">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
            </svg>
            Sender: ${escapeHTML(draft.assignedAccount)}
          </div>
        </div>

        <div class="draft-subject-box">
          <div class="draft-subject-label">Subject Line</div>
          <div class="draft-subject-text">${escapeHTML(draft.subject)}</div>
        </div>

        <div class="draft-body-box">${escapeHTML(draft.body)}</div>

        <div class="draft-controls">
          <button class="btn btn-secondary btn-sm copy-draft-btn" type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy Draft
          </button>
          
          <a href="${gmailUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-gmail btn-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
              <polyline points="22,6 12,13 2,6"></polyline>
            </svg>
            Open in Gmail (${escapeHTML(draft.assignedAccount.split('@')[0])})
          </a>
        </div>
      `;

      card.querySelector('.copy-draft-btn').addEventListener('click', () => {
        copyToClipboard(`Subject: ${draft.subject}\n\n${draft.body}`);
        showToast(`Copied draft for ${draft.contactName}!`, 'success');
      });

      DOM.draftsList.appendChild(card);
    });
  }

  // --- CLIPBOARD ACTIONS ---
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(err => {
        fallbackCopyText(text);
      });
    } else {
      fallbackCopyText(text);
    }
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textarea);
  }

  function copyDraftsList(draftsToCopy, label) {
    if (draftsToCopy.length === 0) {
      showToast('No drafts available to copy.', 'info');
      return;
    }

    const formattedText = draftsToCopy.map((d, idx) => {
      return `=== DRAFT ${idx + 1} | Sender: ${d.assignedAccount} | To: ${d.contactEmail || d.contactName} ===
Subject: ${d.subject}

${d.body}`;
    }).join('\n\n' + '-'.repeat(40) + '\n\n');

    copyToClipboard(formattedText);
    showToast(`Copied ${draftsToCopy.length} drafts (${label}) to clipboard!`, 'success');
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'gmail' ? 'toast-gmail' : ''}`;
    
    let icon = `✓`;
    if (type === 'info') icon = `ℹ`;
    if (type === 'gmail') icon = `✉`;

    toast.innerHTML = `<span>${icon}</span> <span>${escapeHTML(message)}</span>`;
    DOM.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // --- UTILS ---
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    const emailInput = document.getElementById('account-email-input') || DOM.accountEmailInput;
    const passInput = document.getElementById('account-pass-input') || DOM.accountPassInput;
    const addBtn = document.getElementById('add-account-btn') || DOM.addAccountBtn;

    if (addBtn) {
      addBtn.addEventListener('click', () => {
        addAccount();
      });
    }

    if (emailInput) {
      emailInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addAccount();
        }
      });
    }

    if (passInput) {
      passInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addAccount();
        }
      });
    }

    DOM.loadPresetAccountsBtn.addEventListener('click', () => {
      state.accounts = SAMPLE_ACCOUNTS.map(normalizeAccount);
      saveAccounts();
      showToast('Loaded 3 sample sender accounts', 'success');
    });

    DOM.csvInput.addEventListener('input', handleCSVUpdate);
    DOM.loadSampleBtn.addEventListener('click', () => {
      DOM.csvInput.value = SAMPLE_CSV;
      handleCSVUpdate();
      showToast('Loaded sample CSV data', 'success');
    });

    DOM.csvFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        DOM.csvInput.value = evt.target.result;
        handleCSVUpdate();
        showToast(`Loaded ${file.name}`, 'success');
      };
      reader.readAsText(file);
    });

    DOM.resetTemplateBtn.addEventListener('click', () => {
      DOM.templateSubject.value = DEFAULT_TEMPLATE.subject;
      DOM.templateBody.value = DEFAULT_TEMPLATE.body;
      showToast('Reset template to default', 'info');
    });

    DOM.generateBtn.addEventListener('click', generateCampaign);
    DOM.saveImapDraftsBtn.addEventListener('click', saveDraftsToIMAP);
    DOM.launchCampaignBtn.addEventListener('click', launchCampaign);

    DOM.copyVisibleBtn.addEventListener('click', () => {
      const visible = state.activeFilter === 'ALL'
        ? state.drafts
        : state.drafts.filter(d => d.assignedAccount === state.activeFilter);
      copyDraftsList(visible, state.activeFilter === 'ALL' ? 'All Accounts' : state.activeFilter);
    });

    DOM.copyAllBtn.addEventListener('click', () => {
      copyDraftsList(state.drafts, 'All Accounts');
    });
  }

  document.addEventListener('DOMContentLoaded', init);

})();
