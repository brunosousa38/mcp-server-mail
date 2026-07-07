<?php
/**
 * Client SMTP minimal pur PHP sur socket.
 *
 * Gère : SSL implicite ou STARTTLS, EHLO (réponses multi-lignes), AUTH LOGIN
 * (préféré) ou AUTH PLAIN, construction de message RFC 5322 (texte brut,
 * quoted-printable, en-têtes encodés RFC 2047, Message-ID généré,
 * In-Reply-To/References), dot-stuffing et vérification de chaque code réponse.
 */

declare(strict_types=1);

class SmtpException extends RuntimeException
{
}

final class SmtpClient
{
    private const TIMEOUT = 15;

    /** @var resource|null */
    private $sock = null;

    /**
     * Envoie un email.
     *
     * @param array{host:string,port:int,user:string,password:string,encryption:string} $smtpCfg
     * @param array{
     *   from_email:string, from_name:string, to:list<string>, cc:list<string>,
     *   bcc:list<string>, subject:string, body:string, in_reply_to?:?string
     * } $message
     * @return array{message_id:string,accepted:list<string>}
     */
    public function send(array $smtpCfg, array $message): array
    {
        $host = $smtpCfg['host'];
        $port = (int) $smtpCfg['port'];
        $encryption = $smtpCfg['encryption'];

        $ctx = stream_context_create([
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
                'SNI_enabled' => true,
                'peer_name' => $host,
            ],
        ]);
        $scheme = $encryption === 'ssl' ? 'ssl' : 'tcp';
        $sock = @stream_socket_client(
            sprintf('%s://%s:%d', $scheme, $host, $port),
            $errno,
            $errstr,
            self::TIMEOUT,
            STREAM_CLIENT_CONNECT,
            $ctx
        );
        if ($sock === false) {
            throw new SmtpException(sprintf(
                'Connexion SMTP impossible vers %s:%d : %s (%d)',
                $host,
                $port,
                $errstr !== '' ? $errstr : 'erreur inconnue',
                $errno
            ));
        }
        $this->sock = $sock;
        stream_set_timeout($this->sock, self::TIMEOUT);

        try {
            $this->expect([220]); // bannière

            $localHost = gethostname() ?: 'localhost';
            $capabilities = $this->ehlo($localHost);

            if ($encryption === 'starttls') {
                $this->writeLine('STARTTLS');
                $this->expect([220]);
                $ok = @stream_socket_enable_crypto(
                    $this->sock,
                    true,
                    STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT
                );
                if ($ok !== true) {
                    throw new SmtpException('Échec de la négociation STARTTLS avec le serveur SMTP.');
                }
                $capabilities = $this->ehlo($localHost); // re-négociation post-TLS
            }

            $this->authenticate($smtpCfg, $capabilities, $encryption);

            // Enveloppe
            $fromAddr = self::extractAddress($message['from_email']);
            $this->writeLine('MAIL FROM:<' . $fromAddr . '>');
            $this->expect([250]);

            $recipients = array_values(array_unique(array_merge(
                $message['to'],
                $message['cc'],
                $message['bcc']
            )));
            $accepted = [];
            foreach ($recipients as $rcpt) {
                $this->writeLine('RCPT TO:<' . self::extractAddress($rcpt) . '>');
                $this->expect([250, 251]);
                $accepted[] = $rcpt;
            }

            // Données
            [$data, $messageId] = self::buildMessage($message, $fromAddr, $host);
            $this->writeLine('DATA');
            $this->expect([354]);
            $this->writeRaw($data . "\r\n.\r\n");
            $this->expect([250]);

            $this->writeLine('QUIT');
            // Réponse au QUIT lue en best-effort : certains serveurs coupent direct.
            try {
                $this->readResponse();
            } catch (Throwable) {
            }

            return ['message_id' => $messageId, 'accepted' => $accepted];
        } finally {
            if (is_resource($this->sock)) {
                @fclose($this->sock);
            }
            $this->sock = null;
        }
    }

    // ------------------------------------------------------------------
    // Protocole
    // ------------------------------------------------------------------

    /**
     * EHLO + collecte des capacités annoncées (lignes 250-... / 250 ...).
     *
     * @return list<string> capacités en majuscules (ex. "AUTH LOGIN PLAIN", "STARTTLS")
     */
    private function ehlo(string $localHost): array
    {
        $this->writeLine('EHLO ' . $localHost);
        [$code, $lines] = $this->readResponse();
        if ($code !== 250) {
            // Fallback HELO pour les vieux serveurs
            $this->writeLine('HELO ' . $localHost);
            $this->expect([250]);
            return [];
        }
        $caps = [];
        foreach (array_slice($lines, 1) as $line) {
            $caps[] = strtoupper(trim($line));
        }
        return $caps;
    }

    /**
     * AUTH LOGIN préféré, AUTH PLAIN sinon. Si aucun mécanisme AUTH n'est
     * annoncé : toléré en clair (encryption=none, serveur de test), erreur sinon.
     *
     * @param array{user:string,password:string} $smtpCfg
     * @param list<string> $capabilities
     */
    private function authenticate(array $smtpCfg, array $capabilities, string $encryption): void
    {
        $user = $smtpCfg['user'];
        $pass = $smtpCfg['password'];
        if ($user === '') {
            return; // pas d'identifiants configurés : pas d'authentification
        }

        $mechanisms = [];
        foreach ($capabilities as $cap) {
            if (str_starts_with($cap, 'AUTH ') || str_starts_with($cap, 'AUTH=')) {
                $mechanisms = preg_split('/[\s=]+/', substr($cap, 5), -1, PREG_SPLIT_NO_EMPTY) ?: [];
                break;
            }
        }

        if ($mechanisms === []) {
            if ($encryption === 'none') {
                return; // serveur de test sans AUTH : on saute sans erreur
            }
            throw new SmtpException('Le serveur SMTP ne propose aucun mécanisme AUTH supporté (LOGIN/PLAIN).');
        }

        if (in_array('LOGIN', $mechanisms, true)) {
            $this->writeLine('AUTH LOGIN');
            $this->expect([334]);
            $this->writeLine(base64_encode($user));
            $this->expect([334]);
            $this->writeLine(base64_encode($pass));
            $this->expectAuthSuccess();
        } elseif (in_array('PLAIN', $mechanisms, true)) {
            $this->writeLine('AUTH PLAIN ' . base64_encode("\0" . $user . "\0" . $pass));
            $this->expectAuthSuccess();
        } else {
            throw new SmtpException(
                'Mécanismes AUTH proposés non supportés : ' . implode(', ', $mechanisms) . ' (LOGIN/PLAIN requis).'
            );
        }
    }

    private function expectAuthSuccess(): void
    {
        [$code, $lines] = $this->readResponse();
        if ($code !== 235) {
            throw new SmtpException('Authentification SMTP refusée : ' . implode(' / ', $lines));
        }
    }

    /**
     * Lit une réponse SMTP (mono ou multi-lignes "250-... 250 ...").
     *
     * @return array{0:int,1:list<string>} code final + textes de chaque ligne
     */
    private function readResponse(): array
    {
        $lines = [];
        while (true) {
            $raw = fgets($this->sock);
            if ($raw === false) {
                throw new SmtpException('Connexion SMTP interrompue pendant la lecture de la réponse.');
            }
            $line = rtrim($raw, "\r\n");
            if (!preg_match('/^(\d{3})([ -])(.*)$/', $line, $m)) {
                throw new SmtpException('Réponse SMTP illisible : ' . $line);
            }
            $lines[] = $m[3];
            if ($m[2] === ' ') {
                return [(int) $m[1], $lines];
            }
        }
    }

    /** @param list<int> $codes */
    private function expect(array $codes): void
    {
        [$code, $lines] = $this->readResponse();
        if (!in_array($code, $codes, true)) {
            throw new SmtpException(sprintf(
                'Réponse SMTP inattendue (%d, attendu %s) : %s',
                $code,
                implode('/', $codes),
                implode(' / ', $lines)
            ));
        }
    }

    private function writeLine(string $line): void
    {
        $this->writeRaw($line . "\r\n");
    }

    private function writeRaw(string $data): void
    {
        $total = strlen($data);
        $written = 0;
        while ($written < $total) {
            $n = fwrite($this->sock, substr($data, $written));
            if ($n === false || $n === 0) {
                throw new SmtpException('Écriture sur la connexion SMTP impossible (connexion fermée ?).');
            }
            $written += $n;
        }
    }

    // ------------------------------------------------------------------
    // Construction du message
    // ------------------------------------------------------------------

    /**
     * Construit le message RFC 5322 complet, fins de ligne CRLF, dot-stuffing
     * appliqué. Selon les champs fournis :
     *   - body seul               → text/plain
     *   - html seul               → text/html
     *   - body + html             → multipart/alternative
     *   - + attachments           → multipart/mixed encapsulant ce qui précède
     *
     * @param array{
     *   from_email:string, from_name:string, to:list<string>, cc:list<string>,
     *   bcc:list<string>, subject:string, body:?string, html?:?string,
     *   in_reply_to?:?string,
     *   attachments?:list<array{filename:string, content_b64:string, content_type:string}>
     * } $message
     * @return array{0:string,1:string} [données prêtes pour DATA, Message-ID généré]
     */
    private static function buildMessage(array $message, string $fromAddr, string $smtpHost): array
    {
        $domain = substr(strrchr($fromAddr, '@') ?: '', 1);
        if ($domain === '' || $domain === false) {
            $domain = $smtpHost !== '' ? $smtpHost : (gethostname() ?: 'localhost');
        }
        $messageId = '<' . bin2hex(random_bytes(16)) . '@' . $domain . '>';

        $fromName = self::sanitizeHeaderValue($message['from_name']);
        $from = $fromName !== ''
            ? self::encodeHeaderText($fromName) . ' <' . $fromAddr . '>'
            : $fromAddr;

        $headers = [];
        $headers[] = 'Date: ' . date('r');
        $headers[] = 'From: ' . $from;
        $headers[] = 'To: ' . self::sanitizeHeaderValue(implode(', ', $message['to']));
        if ($message['cc'] !== []) {
            $headers[] = 'Cc: ' . self::sanitizeHeaderValue(implode(', ', $message['cc']));
        }
        // Bcc : jamais dans les en-têtes (uniquement dans l'enveloppe RCPT TO).
        $headers[] = 'Subject: ' . self::encodeHeaderText(self::sanitizeHeaderValue($message['subject']));
        $headers[] = 'Message-ID: ' . $messageId;

        $inReplyTo = self::sanitizeHeaderValue((string) ($message['in_reply_to'] ?? ''));
        if ($inReplyTo !== '') {
            if ($inReplyTo[0] !== '<') {
                $inReplyTo = '<' . $inReplyTo . '>';
            }
            $headers[] = 'In-Reply-To: ' . $inReplyTo;
            $headers[] = 'References: ' . $inReplyTo;
        }

        $headers[] = 'MIME-Version: 1.0';

        // Corps (text/plain, text/html ou multipart/alternative).
        [$bodyHeaders, $bodyContent] = self::buildBodyPart(
            $message['body'] ?? null,
            $message['html'] ?? null,
        );

        $attachments = $message['attachments'] ?? [];
        if ($attachments === []) {
            $data = implode("\r\n", array_merge($headers, $bodyHeaders))
                . "\r\n\r\n" . $bodyContent;
        } else {
            $boundary = 'mixed_' . bin2hex(random_bytes(12));
            $headers[] = 'Content-Type: multipart/mixed; boundary="' . $boundary . '"';

            $parts = [implode("\r\n", $bodyHeaders) . "\r\n\r\n" . $bodyContent];
            foreach ($attachments as $att) {
                $parts[] = self::buildAttachmentPart($att);
            }

            $mixed = '';
            foreach ($parts as $part) {
                $mixed .= '--' . $boundary . "\r\n" . $part . "\r\n";
            }
            $mixed .= '--' . $boundary . "--\r\n";

            $data = implode("\r\n", $headers) . "\r\n\r\n" . $mixed;
        }

        // Dot-stuffing : toute ligne commençant par "." est doublée.
        $data = preg_replace('/^\./m', '..', $data) ?? $data;

        return [$data, $messageId];
    }

    /**
     * Construit la partie « corps » du message.
     *
     * @return array{0:list<string>,1:string} [en-têtes de la partie, contenu]
     */
    private static function buildBodyPart(?string $text, ?string $html): array
    {
        $hasText = $text !== null && $text !== '';
        $hasHtml = $html !== null && $html !== '';

        if ($hasText && $hasHtml) {
            $boundary = 'alt_' . bin2hex(random_bytes(12));
            $textPart = "Content-Type: text/plain; charset=utf-8\r\n"
                . "Content-Transfer-Encoding: quoted-printable\r\n\r\n"
                . self::qpBody($text);
            $htmlPart = "Content-Type: text/html; charset=utf-8\r\n"
                . "Content-Transfer-Encoding: quoted-printable\r\n\r\n"
                . self::qpBody($html);
            $content = '--' . $boundary . "\r\n" . $textPart . "\r\n"
                . '--' . $boundary . "\r\n" . $htmlPart . "\r\n"
                . '--' . $boundary . "--\r\n";
            return [
                ['Content-Type: multipart/alternative; boundary="' . $boundary . '"'],
                $content,
            ];
        }

        if ($hasHtml) {
            return [
                ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'],
                self::qpBody($html),
            ];
        }

        return [
            ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'],
            self::qpBody((string) $text),
        ];
    }

    /**
     * Construit une partie MIME de pièce jointe (base64).
     *
     * @param array{filename:string, content_b64:string, content_type:string} $att
     */
    private static function buildAttachmentPart(array $att): string
    {
        $ctype = self::sanitizeHeaderValue($att['content_type']);
        if ($ctype === '' || !preg_match('#^[\x21-\x7e]+/[\x21-\x7e]+$#', $ctype)) {
            $ctype = 'application/octet-stream';
        }
        $nameParam = self::mimeFilenameParam('name', $att['filename']);
        $dispParam = self::mimeFilenameParam('filename', $att['filename']);

        // Re-découpage du base64 en lignes de 76 caractères (RFC 2045).
        $b64 = rtrim(chunk_split($att['content_b64'], 76, "\r\n"));

        $headers = [
            'Content-Type: ' . $ctype . '; ' . $nameParam,
            'Content-Transfer-Encoding: base64',
            'Content-Disposition: attachment; ' . $dispParam,
        ];
        return implode("\r\n", $headers) . "\r\n\r\n" . $b64;
    }

    /**
     * Rend un paramètre de nom de fichier sûr pour un en-tête MIME. ASCII →
     * quoted-string échappée ; non-ASCII → RFC 2231 (filename*=UTF-8''…).
     * Les CR/LF/NUL sont retirés dans tous les cas (anti-injection d'en-tête).
     */
    private static function mimeFilenameParam(string $key, string $filename): string
    {
        $name = str_replace(["\r", "\n", "\0"], '', $filename);
        if (!preg_match('/[^\x20-\x7e]/', $name)) {
            $escaped = str_replace(['\\', '"'], ['\\\\', '\\"'], $name);
            return $key . '="' . $escaped . '"';
        }
        return $key . "*=UTF-8''" . rawurlencode($name);
    }

    /** Normalise les fins de ligne en CRLF puis encode en quoted-printable. */
    private static function qpBody(string $body): string
    {
        $body = str_replace(["\r\n", "\r"], "\n", $body);
        $body = str_replace("\n", "\r\n", $body);
        return quoted_printable_encode($body);
    }

    /** Extrait l'adresse pure d'une chaîne éventuellement au format "Nom <adresse>". */
    public static function extractAddress(string $addr): string
    {
        // Rejet des CR/LF sur l'entrée brute, avant toute extraction : sinon
        // "a@b\r\nRCPT TO:<x@evil>" fournirait une adresse extraite "propre".
        if (preg_match('/[\r\n]/', $addr)) {
            throw new SmtpException('Adresse email invalide : ' . self::sanitizeHeaderValue($addr));
        }
        $addr = trim($addr);
        if (preg_match('/<([^>]+)>/', $addr, $m)) {
            $addr = trim($m[1]);
        }
        // Adresse injectée telle quelle dans MAIL FROM / RCPT TO : tout
        // caractère de contrôle ou blanc permettrait une injection de
        // commande SMTP (ex. "a@b\r\nRCPT TO:<x@evil>").
        if ($addr === ''
            || preg_match('/[\x00-\x20\x7f<>"(),;:\\\\]/', $addr)
            || substr_count($addr, '@') !== 1
        ) {
            throw new SmtpException('Adresse email invalide : ' . self::sanitizeHeaderValue($addr));
        }
        return $addr;
    }

    /** Neutralise toute injection d'en-tête (CR/LF interdits dans une valeur). */
    private static function sanitizeHeaderValue(string $v): string
    {
        return trim(str_replace(["\r", "\n"], ' ', $v));
    }

    /** Encode une valeur d'en-tête en RFC 2047 si elle contient du non-ASCII. */
    private static function encodeHeaderText(string $v): string
    {
        if (!preg_match('/[^\x20-\x7e]/', $v)) {
            return $v;
        }
        if (function_exists('mb_encode_mimeheader')) {
            $encoded = @mb_encode_mimeheader($v, 'UTF-8', 'B', "\r\n");
            if (is_string($encoded) && $encoded !== '') {
                return $encoded;
            }
        }
        return '=?UTF-8?B?' . base64_encode($v) . '?=';
    }
}
