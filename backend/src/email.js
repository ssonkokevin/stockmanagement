import Mailjet from "node-mailjet";

let mailjetClient = null;

export function initEmail() {
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const from = process.env.MAILJET_FROM_EMAIL;

  if (!apiKey || !secretKey || !from || from === "replace_me") {
    // Missing config → stay in demo mode
    return false;
  }

  mailjetClient = Mailjet.apiConnect(apiKey, secretKey);
  return true;
}

export async function sendApprovalEmail({ to, subject, html }) {
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const from = process.env.MAILJET_FROM_EMAIL;

  if (!apiKey || !secretKey || !from || from === "replace_me") {
    // Demo mode: log instead of sending
    console.log("[Email:demo-mailjet]", {
      to,
      subject,
      from,
      htmlPreview: html ? html.slice(0, 160) + "..." : "",
    });
    return;
  }

  if (!mailjetClient) {
    mailjetClient = Mailjet.apiConnect(apiKey, secretKey);
  }

  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: from,
            Name: "Hamilton MVNE",
          },
          To: [
            {
              Email: to,
            },
          ],
          Subject: subject,
          HTMLPart: html,
        },
      ],
    });
    console.log("[Email:mailjet] Sent approval email to", to);
  } catch (err) {
    console.error("[Email:mailjet] Send failed:", err?.response?.body || err);
  }
}

