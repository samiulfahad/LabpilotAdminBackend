// plugins/sms.js
import fp from "fastify-plugin";

async function smsPlugin(fastify) {
  const formatBDPhone = (phone) => `880${phone.replace(/^0/, "")}`;

  fastify.decorate("sendSMS", async ({ number, message }) => {
    const params = new URLSearchParams({
      api_key: process.env.BULKSMS_API_KEY,
      senderid: process.env.BULKSMS_SENDER_ID,
      type: "text",
      number: formatBDPhone(number),
      message,
    });

    const response = await fetch(`http://bulksmsbd.net/api/smsapi?${params}`);

    if (!response.ok) {
      throw new Error(`SMS API request failed with status ${response.status}`);
    }

    return response.json();
  });
}

export default fp(smsPlugin);
