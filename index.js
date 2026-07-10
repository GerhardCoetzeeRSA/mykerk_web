/**
 * MyKerk MyChurch — Zapper payment integration (Cloud Functions)
 * Merchant API Key confirmed by Zapper support (ref: 5Q60493M9773KKVG58)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

admin.initializeApp();

const ZAPPER_MERCHANT_API_KEY = '6c48d74081e0421bb1afce2edc9b4dde';
const ZAPPER_MERCHANT_ID = '76032';
const ZAPPER_SITE_IDS = { monthly: '96013', annual: '96037' };
const PLAN_TIERS = {
  starter:  { monthly: 349, annual: 3490 },
  standard: { monthly: 649, annual: 6490 },
  premium:  { monthly: 999, annual: 9990 }
};

const ZAPPER_API_BASE = 'https://api.zapper.com/business/api/v1';

// ── 1. CREATE INVOICE ──
exports.createZapperInvoice = onCall(
  { region: 'us-central1' },
  async (request) => {
    const { gemeenteId, tier, billing } = request.data || {};

    if (!gemeenteId || typeof gemeenteId !== 'string') {
      throw new HttpsError('invalid-argument', 'gemeenteId is required');
    }
    if (!PLAN_TIERS[tier]) {
      throw new HttpsError('invalid-argument', 'Invalid tier: ' + tier);
    }
    if (billing !== 'monthly' && billing !== 'annual') {
      throw new HttpsError('invalid-argument', 'Invalid billing: ' + billing);
    }

    const amountRand = PLAN_TIERS[tier][billing];
    const amountCents = Math.round(amountRand * 100);
    const siteId = ZAPPER_SITE_IDS[billing];
    const externalReference = `MK_${gemeenteId.substring(0, 10)}_${Date.now()}`;

    // Request body exactly as confirmed by Zapper support
    const now = new Date();
    const createdUTCDate = now.toISOString().replace('T', ' ').substring(0, 19);
    const requestBody = {
      externalReference: externalReference,
      siteReference: 'MYKERK-WEB-001',
      currencyISOCode: 'ZAR',
      amount: amountCents,
      origin: 'MyKerkMyChurch',
      createdUTCDate: createdUTCDate
    };

    logger.info('Zapper invoice request', {
      url: `${ZAPPER_API_BASE}/merchants/${ZAPPER_MERCHANT_ID}/sites/${siteId}/invoices`,
      body: requestBody
    });

    let zapperResp;
    try {
      zapperResp = await fetch(
        `${ZAPPER_API_BASE}/merchants/${ZAPPER_MERCHANT_ID}/sites/${siteId}/invoices`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'image/svg+xml',
            'Authorization': `Bearer ${ZAPPER_MERCHANT_API_KEY}`
          },
          body: JSON.stringify(requestBody)
        }
      );
    } catch (err) {
      logger.error('Zapper network error', err);
      throw new HttpsError('internal', 'Could not reach Zapper: ' + err.message);
    }

    const responseBody = await zapperResp.text().catch(() => '');
    logger.info('Zapper response', {
      status: zapperResp.status,
      statusText: zapperResp.statusText,
      body: responseBody.substring(0, 500)
    });

    if (!zapperResp.ok) {
      logger.error('Zapper invoice error', zapperResp.status, responseBody);
      throw new HttpsError(
        'internal',
        `Zapper error ${zapperResp.status}: ${responseBody.substring(0, 200)}`
      );
    }

    const invoiceReference = zapperResp.headers.get('reference') || externalReference;

    await admin.firestore().collection('gemeentes').doc(gemeenteId).set(
      {
        pendingZapperInvoice: {
          reference: invoiceReference,
          externalReference: externalReference,
          tier, billing,
          amount: amountRand,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }
      },
      { merge: true }
    );

    return { svg: responseBody, reference: invoiceReference };
  }
);

// ── 2. WEBHOOK ──
exports.zapperWebhook = onRequest(
  { region: 'us-central1' },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    const body = req.body || {};
    logger.info('Zapper webhook received', body);

    const zapperId = body.zapperId || body.ZapperId;
    const invoiceReference = body.invoiceReference || body.invoiceExternalReference || body.reference;

    if (!zapperId || !invoiceReference) {
      logger.warn('Webhook missing zapperId or reference', body);
      res.status(400).send('Missing zapperId or invoice reference');
      return;
    }

    let verifyResp;
    try {
      verifyResp = await fetch(
        `${ZAPPER_API_BASE}/merchants/${ZAPPER_MERCHANT_ID}/payments/${zapperId}`,
        { headers: { 'Authorization': `Bearer ${ZAPPER_MERCHANT_API_KEY}`, 'Accept': 'application/json' } }
      );
    } catch (err) {
      logger.error('Could not verify payment', err);
      res.status(200).send('OK');
      return;
    }

    if (!verifyResp.ok) {
      logger.error('Payment verification failed', verifyResp.status);
      res.status(200).send('OK');
      return;
    }

    let snap = await admin.firestore().collection('gemeentes')
      .where('pendingZapperInvoice.reference', '==', invoiceReference).limit(1).get();

    if (snap.empty) {
      snap = await admin.firestore().collection('gemeentes')
        .where('pendingZapperInvoice.externalReference', '==', invoiceReference).limit(1).get();
    }

    if (snap.empty) {
      logger.warn('No gemeente found for reference', invoiceReference);
      res.status(200).send('OK');
      return;
    }

    const doc = snap.docs[0];
    const pending = doc.data().pendingZapperInvoice;
    const paidUntil = new Date();
    if (pending.billing === 'annual') { paidUntil.setFullYear(paidUntil.getFullYear() + 1); }
    else { paidUntil.setMonth(paidUntil.getMonth() + 1); }

    await doc.ref.update({
      subscription: {
        status: 'active', tier: pending.tier, plan: pending.billing,
        paidUntil: paidUntil.toISOString(), activatedAt: new Date().toISOString(),
        zapperId, invoiceReference
      },
      pendingZapperInvoice: admin.firestore.FieldValue.delete()
    });

    logger.info('Subscription activated', { gemeenteId: doc.id, tier: pending.tier });
    res.status(200).send('OK');
  }
);

// ── 3. LOOKUP GEMEENTE BY CODE ──
// Used during member self-registration, before the person has an account.
// Runs with admin privileges server-side so it can bypass Firestore rules,
// and returns ONLY the two fields the registration form needs — never the
// full gemeente document (no adminEmail, subscription status, etc.)
exports.lookupGemeenteByCode = onCall(
  { region: 'us-central1' },
  async (request) => {
    const code = String((request.data && request.data.code) || '').trim().toUpperCase();

    if (!code) {
      throw new HttpsError('invalid-argument', 'Gemeente-kode is vereis.');
    }

    const snap = await admin.firestore()
      .collection('gemeentes')
      .where('gemeenteCode', '==', code)
      .limit(1)
      .get();

    if (snap.empty) {
      return { found: false };
    }

    const doc = snap.docs[0];
    const data = doc.data();

    return {
      found: true,
      gemeenteId: doc.id,
      churchName: data.churchName || ''
    };
  }
);
