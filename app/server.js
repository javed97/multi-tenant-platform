const express = require('express');
const { Kafka, logLevel } = require('kafkajs');
const app = express();

const PORT = process.env.PORT || 3000;
const TENANT = process.env.TENANT || 'unknown';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'kafka.kafka.svc.cluster.local:9092').split(',');

app.get('/', (req, res) => {
  res.send(`<html><body style="font-family: sans-serif; padding: 2rem;">
    <h1>Welcome to ${TENANT}'s website</h1>
    <p>Pod: ${process.env.HOSTNAME}</p>
    <p>Served at: ${new Date().toISOString()}</p>
  </body></html>`);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok', tenant: TENANT }));
app.get('/readyz', (req, res) => res.json({ status: 'ready', tenant: TENANT }));
app.get('/burn', (req, res) => {
  const end = Date.now() + 200;
  while (Date.now() < end) { Math.sqrt(Math.random() * 999999); }
  res.json({ burned_ms: 200, tenant: TENANT });
});

async function publishWebsiteCreated() {
  const kafka = new Kafka({
    clientId: `app-${TENANT}`,
    brokers: KAFKA_BROKERS,
    logLevel: logLevel.ERROR,
    retry: { retries: 3, initialRetryTime: 500 },
  });
  const producer = kafka.producer();
  try {
    await producer.connect();
    await producer.send({
      topic: 'website-events',
      messages: [{
        key: TENANT,
        value: JSON.stringify({
          event: 'WebsiteCreated',
          tenant: TENANT,
          pod: process.env.HOSTNAME,
          timestamp: new Date().toISOString(),
        }),
      }],
    });
    console.log(`[kafka] WebsiteCreated event published for ${TENANT}`);
    await producer.disconnect();
  } catch (err) {
    console.error(`[kafka] publish failed (non-fatal): ${err.message}`);
  }
}

app.listen(PORT, () => {
  console.log(`[${TENANT}] listening on :${PORT}`);
  if (process.env.KAFKA_ENABLED === 'true') publishWebsiteCreated();
});
