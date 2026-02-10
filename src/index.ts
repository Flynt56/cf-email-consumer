import {EmailMessage} from "cloudflare:email";
import {createMimeMessage, Mailbox} from "mimetext";

interface Env {
    SEB: SendEmailClient;
    EMAIL_QUEUE: Queue<EmailQueueMessage>;
    BASE_DELAY_SECONDS: number;
}

interface SendEmailClient {
    send(message: EmailMessage): Promise<void>;
}

interface EmailEnvelope {
    name: string;
    email: string;
    message: string;
}

interface MailboxAddress {
    address: string;
    name?: string;
}

interface EmailQueueMessage {
    type: 'send_contact_email';
    data: EmailEnvelope;
    sender: MailboxAddress;
    recipient: MailboxAddress;
    timestamp: number;
}

export default {
    async queue(batch: MessageBatch<EmailQueueMessage>, env: Env) {
        const baseDelaySeconds = env.BASE_DELAY_SECONDS || 30;

        for (const it of batch.messages) {
            const msg = it.body;
            const envelope = msg.data;
            const attemptNum = it.attempts;

            const mimeMsg = createMimeMessage();
            mimeMsg.setSender({addr: msg.sender.address, name: msg.sender.name || msg.sender.address});
            mimeMsg.setRecipient({addr: msg.recipient.address, name: msg.recipient.name || msg.recipient.address});
            mimeMsg.setHeader("Reply-To", new Mailbox({addr: envelope.email, name: envelope.name}));
            mimeMsg.setSubject("Submission");
            mimeMsg.addMessage({
                contentType: "text/plain",
                data: `${envelope.name}\n${envelope.email}\n\n${envelope.message}`
            });

            const emailMessage = new EmailMessage(
                msg.sender.address,
                msg.recipient.address,
                mimeMsg.asRaw()
            );

            console.log(`Sending email.\nTo: ${envelope.email}\nAttempt: ${attemptNum}`);

            try {
                await env.SEB.send(emailMessage);

                console.log("Email sent successfully.");

                it.ack();
            } catch (error: any) {
                const errorMessage = (error as Error).message || String(error);
                const status = error.status || error.code;

                console.log(`Error sending email.\nError: ${errorMessage}\nStatus: ${status}`);

                if (![421, 450, 503, 504].includes(status)) {
                    console.error("Email send failed - PERMANENT.");

                    throw error;
                } else {
                    const totalDelaySeconds = Math.ceil(baseDelaySeconds * Math.pow(2, attemptNum - 1) + Math.random() * 5);

                    console.warn(`Transient error.\nRetrying in: ${totalDelaySeconds}s`);

                    it.retry({delaySeconds: totalDelaySeconds});
                }
            }
        }
    }
} as ExportedHandler<Env>;