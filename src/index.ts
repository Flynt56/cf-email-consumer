import {EmailMessage} from "cloudflare:email";
import {createMimeMessage, Mailbox} from "mimetext";

interface Env {
    SEB: SendEmailClient;
    EMAIL_QUEUE: Queue<EmailQueueMessage>;
    BASE_DELAY_SECONDS: number;
    CONTACT_PATH: string;
}

interface SendEmailClient {
    send(message: EmailMessage): Promise<void>;
}

interface MailboxAddress {
    address: string;
    name?: string;
}

interface EmailEnvelope {
    user: MailboxAddress;
    sender: MailboxAddress;
    recipient: MailboxAddress;
    message: string;
}

interface EmailQueueMessage {
    $type: 'SendContactEmail';
    data: EmailEnvelope;
    timestamp: number;
}

export default {
    async fetch(request: Request, env: Env) {
        if (request.method == "POST" && request.url.endsWith(env.CONTACT_PATH)) {
            const formData = await request.formData();

            const siteId = formData.get("site_id") as string;
            const message = formData.get("message") as string;

            const userMailbox = {
                name: formData.get('user_name'),
                address: formData.get('user_address')
            } as MailboxAddress;

            const senderMailbox = {
                name: formData.get('sender_name'),
                address: formData.get('sender_address')
            } as MailboxAddress;

            const recipientMailbox = {
                name: formData.get('recipient_name'),
                address: formData.get('recipient_address')
            } as MailboxAddress;

            if (!userMailbox.name || !userMailbox.address || !message) {
                return new Response("Missing required fields", {status: 400});
            }

            if (userMailbox.name.length > 255) {
                return new Response("Validation error", {status: 400});
            }

            if (userMailbox.address.length > 254) {
                return new Response("Validation error", {status: 400});
            }

            if (message.length > 1000) {
                return new Response("Validation error", {status: 400});
            }

            const emailEnvelope: EmailEnvelope = {
                user: userMailbox,
                sender: senderMailbox,
                recipient: recipientMailbox,
                message: message
            };

            try {
                await env.EMAIL_QUEUE.send({
                    $type: 'SendContactEmail',
                    data: emailEnvelope,
                    timestamp: Date.now()
                } as EmailQueueMessage);

                console.log(`Email queued.\nFor: ${userMailbox.address}\nFrom: ${userMailbox.name}`);
                return new Response("Email sent successfully.", {status: 200});
            } catch (e) {
                console.error(`Error queuing email.\nError: ${e}`);
                return new Response(`Error: ${(e as Error).message}`, {status: 500});
            }
        }

        return new Response("Not Found", {status: 404});
    },
    async queue(batch: MessageBatch<EmailQueueMessage>, env: Env) {
        const baseDelaySeconds = env.BASE_DELAY_SECONDS || 30;

        for (const it of batch.messages) {
            const msg = it.body;
            const envelope = msg.data;
            const attemptNum = it.attempts;

            const mimeMsg = createMimeMessage();
            mimeMsg.setSender({addr: envelope.sender.address, name: envelope.sender.name || envelope.sender.address});
            mimeMsg.setRecipient({
                addr: envelope.recipient.address,
                name: envelope.recipient.name || envelope.recipient.address
            });
            mimeMsg.setHeader("Reply-To", new Mailbox({addr: envelope.user.address, name: envelope.user.name}));
            mimeMsg.setSubject("New Contact Form Submission");
            mimeMsg.addMessage({
                contentType: "text/plain",
                data: `Name: ${envelope.user.name}\nEmail: ${envelope.user.address}\n\nMessage:\n${envelope.message}`
            });

            const emailMessage = new EmailMessage(
                envelope.sender.address,
                envelope.recipient.address,
                mimeMsg.asRaw()
            );

            console.log(`[Queue] Processing message. Type: ${msg.$type}, Attempt: ${attemptNum}`);
            console.log(`[Queue] Sending email from ${envelope.sender.address} to ${envelope.recipient.address}`);

            try {
                await env.SEB.send(emailMessage);

                console.log("[Queue] Email sent successfully.");

                it.ack();
            } catch (error: any) {
                const errorMessage = (error as Error).message || String(error);
                const status = error.status || error.code;

                console.error(`[Queue] Error sending email: ${errorMessage} (Status/Code: ${status})`);

                // SMTP transient error codes:
                // 421: Service not available
                // 450: Mailbox unavailable (busy or temporarily blocked)
                // 451: Local error in processing
                // 452: Insufficient system storage
                // 503/504: Sometimes returned by Cloudflare for transient issues
                const retryableStatuses = [421, 450, 451, 452, 503, 504];

                if (retryableStatuses.includes(status)) {
                    const totalDelaySeconds = Math.ceil(baseDelaySeconds * Math.pow(2, attemptNum - 1) + Math.random() * 5);

                    console.warn(`[Queue] Transient error. Retrying in ${totalDelaySeconds}s...`);

                    it.retry({delaySeconds: totalDelaySeconds});
                } else {
                    console.error("[Queue] Permanent failure. Message will be moved to DLQ if max retries reached.");
                    throw error;
                }
            }
        }
    }
} as ExportedHandler<Env>;