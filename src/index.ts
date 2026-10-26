import {EmailMessage} from 'cloudflare:email';
import {createMimeMessage, Mailbox} from 'mimetext';

/*
 * The contact-form mailer: sites post a submission here, it goes on a queue, and the queue handler sends it as an email
 * to the site's own address, with the visitor as Reply-To.
 *
 * Data protection (GDPR):
 * - Logs never carry the visitor's name, email address or message, only the site, the step, and status codes. Error
 *   texts are logged with any email address in them replaced by [address].
 * - The queue holds each submission until it's sent, and the dead-letter queue keeps the ones that failed. Both are
 *   personal data: keep their message retention short (the queue's settings in Cloudflare) and empty the dead-letter
 *   queue once failures are looked at.
 * - Callers get a generic error, so nothing about the visitor or the setup is echoed back.
 *
 * Security: the sender and recipient come from SITES, configured per site on the server, never from the request, so
 * the worker can't be used to mail anyone else (an open relay). Sender and recipient fields in a request are ignored.
 * Also: pin allowed_destination_addresses on the send_email binding, and set workers_dev: false with no route, since
 * sites reach it through a service binding only.
 */

interface Env {
    SEB: SendEmailClient;
    EMAIL_QUEUE: Queue<EmailQueueMessage>;
    BASE_DELAY_SECONDS?: number | string;
    CONTACT_PATH: string;
    /** Per site_id, an object var in wrangler.jsonc, e.g.
     *  "SITES": {"vo": {"sender": {"address": "contact@mail.ib.actor", "name": "Contact Form"},
     *                     "recipient": {"address": "hey@ib.actor"}}} */
    SITES: Record<string, SiteConfig>;
}

interface SiteConfig {
    sender: MailboxAddress;
    recipient: MailboxAddress;
}

interface SendEmailClient {
    send(message: EmailMessage): Promise<void>;
}

interface MailboxAddress {
    address: string;
    name?: string | undefined;
}

interface EmailEnvelope {
    site: string;
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

const log = (event: string) => {
    console.log(`Contact mailer: ${event}`);
};

/** Error text with email addresses taken out, since a mail error can quote them. */
const redact = (text: string) => text.replace(/[^\s<>@"]+@[^\s<>@"]+/g, '[address]');

/** A line break in a name could add headers to the email, so such submissions are refused. */
const hasLineBreak = (text: string) => /[\r\n]/.test(text);

export default {
    async fetch(request: Request, env: Env) {
        if (request.method === 'POST' && new URL(request.url).pathname === env.CONTACT_PATH) {
            const formData = await request.formData();
            const field = (name: string) => {
                const value = formData.get(name);
                return typeof value === 'string' ? value : '';
            };

            // Only a configured site_id is accepted; an unknown one isn't echoed into the logs.
            const site = field('site_id');
            const config = Object.hasOwn(env.SITES, site) ? env.SITES[site] : undefined;
            if (!config) {
                log('rejected, unknown site');
                return new Response('Validation error', {status: 400});
            }
            const {sender, recipient} = config;
            const message = field('message');
            const user: MailboxAddress = {name: field('user_name'), address: field('user_address')};

            const invalid =
                !user.name || !user.address || !message
                    ? 'a field is empty'
                    : user.name.length > 255
                      ? 'name too long'
                      : user.address.length > 254
                        ? 'email address too long'
                        : message.length > 1000
                          ? 'message too long'
                          : hasLineBreak(user.name) || hasLineBreak(user.address)
                            ? 'line break in name or address'
                            : '';
            if (invalid) {
                log(`${site}: rejected, ${invalid}`);
                return new Response('Validation error', {status: 400});
            }

            try {
                await env.EMAIL_QUEUE.send({
                    $type: 'SendContactEmail',
                    data: {site, user, sender, recipient, message},
                    timestamp: Date.now(),
                });

                log(`${site}: queued, message of ${message.length} characters`);
                return new Response('Email queued.', {status: 200});
            } catch (e) {
                console.error(`Contact mailer: ${site}: queuing failed. ${redact(String(e))}`);
                return new Response('Error queuing email.', {status: 500});
            }
        }

        return new Response('Not Found', {status: 404});
    },

    async queue(batch: MessageBatch<EmailQueueMessage>, env: Env) {
        const baseDelaySeconds = Number(env.BASE_DELAY_SECONDS ?? 30);

        for (const it of batch.messages) {
            const {data: envelope, $type} = it.body;
            // Messages queued before the site was recorded have no site.
            const site = envelope.site || 'unknown';

            const mimeMsg = createMimeMessage();
            mimeMsg.setSender({addr: envelope.sender.address, name: envelope.sender.name ?? envelope.sender.address});
            mimeMsg.setRecipient({
                addr: envelope.recipient.address,
                name: envelope.recipient.name ?? envelope.recipient.address,
            });
            mimeMsg.setHeader('Reply-To', new Mailbox({addr: envelope.user.address, name: envelope.user.name ?? ''}));
            mimeMsg.setSubject('New Contact Form Submission');
            mimeMsg.addMessage({
                contentType: 'text/plain',
                data: `Name: ${envelope.user.name ?? ''}\nEmail: ${envelope.user.address}\n\nMessage:\n${envelope.message}`,
            });

            const emailMessage = new EmailMessage(envelope.sender.address, envelope.recipient.address, mimeMsg.asRaw());

            log(`${site}: sending ${$type}, attempt ${it.attempts}`);

            try {
                await env.SEB.send(emailMessage);
                log(`${site}: sent`);
                it.ack();
            } catch (error) {
                const {status, code, message} = error as {status?: number; code?: number; message?: string};
                const statusCode = status ?? code;
                console.error(
                    `Contact mailer: ${site}: sending failed (status ${statusCode ?? 'none'}). ${redact(message ?? String(error))}`,
                );

                // SMTP transient error codes:
                // 421: Service not available
                // 450: Mailbox unavailable (busy or temporarily blocked)
                // 451: Local error in processing
                // 452: Insufficient system storage
                // 503/504: Sometimes returned by Cloudflare for transient issues
                const retryableStatuses = [421, 450, 451, 452, 503, 504];

                if (statusCode !== undefined && retryableStatuses.includes(statusCode)) {
                    const delaySeconds = Math.ceil(baseDelaySeconds * Math.pow(2, it.attempts - 1) + Math.random() * 5);
                    console.warn(`Contact mailer: ${site}: transient error, retrying in ${delaySeconds}s.`);
                    it.retry({delaySeconds});
                } else {
                    // Retried as-is until the queue's max_retries, then moved to the dead-letter queue. Retrying this
                    // message alone (instead of throwing) keeps the rest of the batch going and keeps the original
                    // error, which may quote addresses, out of the runtime's logs.
                    console.error(
                        `Contact mailer: ${site}: permanent failure; goes to the dead-letter queue after the last retry.`,
                    );
                    it.retry();
                }
            }
        }
    },
} as ExportedHandler<Env, EmailQueueMessage>;
