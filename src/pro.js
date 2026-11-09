'use strict';
// Zovo Pro for Azure Storage Explorer. Pro adds two tools for professional work: folder sync with a dry-run diff, and
// the storage usage and cost report. Connecting, browsing, opening, upload, download, the transfer queue, SAS URLs,
// properties, tiers, delete, rename, queues and tables stay free for good.
// Each Pro tool has 3 free tries per computer (a local counter, no network). After that, one modal explains it, only
// when the user starts that tool. Nothing about Pro shows on its own: no popup on open, no nag, no countdown.
const { createLicense } = require('./license');

const PRO_ENABLED = true; // false: every Pro tool is free and no Pro text shows anywhere
const FREE_TRIES = 3;
const TRIES_KEY = 'zovo.azurestorage.proTries.v1';
const SKU = 'azure-storage-pro';

const FEATURES = {
  sync: { name: 'Folder sync', detail: 'Compares a local folder with a container or folder and shows what is new, changed or missing (a dry run) before anything is copied. Then it uploads or downloads only the differences.' },
  usage: { name: 'Usage and cost report', detail: 'Lists every blob in a container or folder and shows size, blob count and an estimated monthly cost per folder and access tier, plus the 10 largest blobs.' },
};

const PRO_TEXT = 'Zovo Pro is USD 19 once and unlocks Pro in every Zovo extension. Bought it already on GitHub Sponsors, or sponsor monthly with USD 10 or more? Choose Unlock with GitHub Sponsors. Unlocking sends one question to GitHub, nothing else. Browsing, opening, upload, download, SAS URLs, queues and tables stay free.';

function createPro({ vscode, context, license, enabled = PRO_ENABLED }) {
  const lic = license || (enabled ? createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'azureStorage', product: 'Azure Storage Explorer' }) : null);
  if (!lic) {
    for (const c of ['getPro', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense', 'payWithPayPal']) {
      context.subscriptions.push(vscode.commands.registerCommand(`azureStorage.${c}`, () => vscode.window.showInformationMessage('Everything in Azure Storage Explorer is free.')));
    }
  }
  const tries = () => Object.assign({}, context.globalState.get(TRIES_KEY) || {});

  /** For a Pro tool the user started. Returns { ok, note }: ok when it may run now; note like "free try 1 of 3". */
  async function gate(feature) {
    if (!enabled || !lic) return { ok: true, note: '' };
    await lic.ready;
    if (lic.isPro(SKU)) { Promise.resolve(lic.refresh && lic.refresh()).catch(() => {}); return { ok: true, note: '' }; }
    const t = tries();
    const used = Number(t[feature]) || 0;
    if (used < FREE_TRIES) {
      t[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, t);
      return { ok: true, note: `${FEATURES[feature].name} is a Zovo Pro tool: free try ${used + 1} of ${FREE_TRIES}.` };
    }
    const f = FEATURES[feature];
    const ok = await lic.requirePro(f.name, `${f.detail}\n\n${PRO_TEXT}`);
    return { ok: !!ok, note: '' };
  }

  return {
    gate,
    enabled: !!enabled,
    isPro: () => !enabled || !lic || lic.isPro(SKU),
    triesLeft: (feature) => Math.max(0, FREE_TRIES - (Number(tries()[feature]) || 0)),
    license: lic,
  };
}

module.exports = { createPro, PRO_ENABLED, FREE_TRIES, FEATURES, TRIES_KEY, SKU, PRO_TEXT };
