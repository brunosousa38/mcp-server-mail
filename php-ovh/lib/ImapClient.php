<?php
/**
 * Client IMAP pur PHP sur socket (aucune dépendance à ext-imap).
 *
 * Implémente le sous-ensemble de RFC 3501 nécessaire aux outils MCP :
 * LOGIN (via littéraux), LIST, STATUS, SELECT/EXAMINE, FETCH (avec gestion
 * des littéraux {N} en réception), UID SEARCH (littéraux en émission pour
 * les critères texte), UID STORE, LOGOUT.
 *
 * Les réponses sont lues sous forme de « lignes logiques » : quand une ligne
 * se termine par {N}, les N octets bruts suivants sont lus tels quels puis la
 * suite de la ligne est assemblée. Chaque ligne logique est retournée comme
 * ['text' => string, 'literals' => [['offset' => int, 'length' => int], ...]]
 * — les plages `literals` permettent d'extraire le contenu brut exact d'un
 * littéral (en-têtes ou message complet) sans ré-analyse ambiguë.
 */

declare(strict_types=1);

class ImapException extends RuntimeException
{
}

final class ImapClient
{
    private const TIMEOUT = 15;

    /** @var resource|null */
    private $sock = null;
    private int $tagCounter = 0;

    public function __construct(
        private string $host,
        private int $port,
        private string $encryption = 'ssl'
    ) {
    }

    public function __destruct()
    {
        $this->close();
    }

    // ------------------------------------------------------------------
    // Connexion / session
    // ------------------------------------------------------------------

    public function connect(): void
    {
        $ctx = stream_context_create([
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
                'SNI_enabled' => true,
                'peer_name' => $this->host,
            ],
        ]);
        $scheme = $this->encryption === 'ssl' ? 'ssl' : 'tcp';
        $sock = @stream_socket_client(
            sprintf('%s://%s:%d', $scheme, $this->host, $this->port),
            $errno,
            $errstr,
            self::TIMEOUT,
            STREAM_CLIENT_CONNECT,
            $ctx
        );
        if ($sock === false) {
            throw new ImapException(sprintf(
                'Connexion IMAP impossible vers %s:%d : %s (%d)',
                $this->host,
                $this->port,
                $errstr !== '' ? $errstr : 'erreur inconnue',
                $errno
            ));
        }
        $this->sock = $sock;
        stream_set_timeout($this->sock, self::TIMEOUT);

        $greeting = $this->readLogicalLine();
        if ($greeting === null) {
            throw new ImapException('Aucun greeting reçu du serveur IMAP.');
        }
        $text = $greeting['text'];
        if (!str_starts_with($text, '* OK') && !str_starts_with($text, '* PREAUTH')) {
            throw new ImapException('Greeting IMAP inattendu : ' . $text);
        }

        if ($this->encryption === 'starttls') {
            $this->sendCommand('STARTTLS');
            $ok = @stream_socket_enable_crypto(
                $this->sock,
                true,
                STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT
            );
            if ($ok !== true) {
                throw new ImapException('Échec de la négociation STARTTLS avec le serveur IMAP.');
            }
        }
    }

    /**
     * Authentification LOGIN en littéraux IMAP : évite tout problème
     * d'échappement dans le mot de passe (guillemets, antislash, UTF-8...).
     */
    public function login(string $user, string $pass): void
    {
        $tag = 'A' . (++$this->tagCounter);
        $this->writeRaw($tag . ' LOGIN {' . strlen($user) . "}\r\n");
        $this->expectContinuation();
        $this->writeRaw($user . ' {' . strlen($pass) . "}\r\n");
        $this->expectContinuation();
        $this->writeRaw($pass . "\r\n");
        try {
            $this->readUntilTagged($tag);
        } catch (ImapException $e) {
            throw new ImapException('Authentification IMAP refusée : ' . $e->getMessage());
        }
    }

    public function logout(): void
    {
        if (is_resource($this->sock)) {
            try {
                $this->sendCommand('LOGOUT');
            } catch (Throwable) {
                // Ignoré : la session se termine de toute façon.
            }
        }
        $this->close();
    }

    public function close(): void
    {
        if (is_resource($this->sock)) {
            @fclose($this->sock);
        }
        $this->sock = null;
    }

    // ------------------------------------------------------------------
    // Opérations de haut niveau
    // ------------------------------------------------------------------

    /**
     * LIST "" "*" puis STATUS (MESSAGES UNSEEN) sur chaque dossier sélectionnable.
     *
     * @return list<array{path:string,path_raw:string,delimiter:?string,flags:list<string>,messages:?int,unseen:?int}>
     */
    public function listFolders(): array
    {
        $lines = $this->sendCommand('LIST "" "*"');
        $folders = [];
        foreach ($lines as $line) {
            $text = $line['text'];
            if (!preg_match('/^\* LIST \(([^)]*)\) ("(?:\\\\.|[^"\\\\])*"|NIL) (.*)$/si', $text, $m)) {
                continue;
            }
            $flags = preg_split('/\s+/', trim($m[1]), -1, PREG_SPLIT_NO_EMPTY) ?: [];
            $delimiter = strcasecmp($m[2], 'NIL') === 0 ? null : self::dequote($m[2]);
            if ($line['literals'] !== []) {
                // Nom de dossier arrivé en littéral : extraire la plage brute exacte.
                $lit = $line['literals'][count($line['literals']) - 1];
                $nameRaw = substr($text, $lit['offset'], $lit['length']);
            } else {
                $nameRaw = trim($m[3]);
                if ($nameRaw !== '' && $nameRaw[0] === '"') {
                    $nameRaw = self::dequote($nameRaw);
                }
            }
            if ($nameRaw === '') {
                continue;
            }

            $selectable = true;
            foreach ($flags as $f) {
                if (strcasecmp($f, '\\Noselect') === 0 || strcasecmp($f, '\\NonExistent') === 0) {
                    $selectable = false;
                    break;
                }
            }

            $messages = null;
            $unseen = null;
            if ($selectable) {
                try {
                    $statusLines = $this->sendCommand('STATUS ' . self::quoteMailbox($nameRaw) . ' (MESSAGES UNSEEN)');
                    foreach ($statusLines as $sl) {
                        if (preg_match('/^\* STATUS .*\(([^)]*)\)\s*$/si', $sl['text'], $sm)) {
                            if (preg_match('/MESSAGES (\d+)/i', $sm[1], $mm)) {
                                $messages = (int) $mm[1];
                            }
                            if (preg_match('/UNSEEN (\d+)/i', $sm[1], $mu)) {
                                $unseen = (int) $mu[1];
                            }
                        }
                    }
                } catch (ImapException) {
                    // Certains serveurs refusent STATUS sur des dossiers spéciaux : on tolère.
                }
            }

            $folders[] = [
                'path' => self::mUtf7Decode($nameRaw),
                'path_raw' => $nameRaw,
                'delimiter' => $delimiter,
                'flags' => array_values($flags),
                'messages' => $messages,
                'unseen' => $unseen,
            ];
        }
        return $folders;
    }

    /** EXAMINE (lecture seule) ou SELECT (lecture/écriture). Retourne le nombre EXISTS. */
    public function selectFolder(string $folder, bool $readOnly = true): int
    {
        $cmd = ($readOnly ? 'EXAMINE ' : 'SELECT ') . self::quoteMailbox(self::normalizeFolderName($folder));
        try {
            $lines = $this->sendCommand($cmd);
        } catch (ImapException $e) {
            throw new ImapException(sprintf("Impossible d'ouvrir le dossier '%s' : %s", $folder, $e->getMessage()));
        }
        foreach ($lines as $line) {
            if (preg_match('/^\* (\d+) EXISTS\b/i', $line['text'], $m)) {
                return (int) $m[1];
            }
        }
        return 0;
    }

    /**
     * Liste les emails d'un dossier, du plus récent au plus ancien.
     *
     * @return list<array<string,mixed>>
     */
    public function listEmails(string $folder, int $limit = 20, int $offset = 0): array
    {
        $limit = max(1, min(100, $limit));
        $offset = max(0, $offset);

        $exists = $this->selectFolder($folder, true);
        $end = $exists - $offset;
        if ($end < 1) {
            return [];
        }
        $start = max(1, $end - $limit + 1);

        $lines = $this->sendCommand(sprintf(
            'FETCH %d:%d (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])',
            $start,
            $end
        ));
        $emails = $this->parseEnvelopeFetch($lines);
        // FETCH start:end renvoie l'ordre croissant de séquence (donc chronologique) :
        // on inverse pour avoir le plus récent en premier.
        return array_reverse($emails);
    }

    /**
     * UID SEARCH avec critères optionnels, puis FETCH des en-têtes.
     * Les valeurs texte sont systématiquement transmises en littéraux IMAP.
     *
     * @param array{from?:string,to?:string,subject?:string,text?:string,since?:string,before?:string,unseen?:bool} $criteria
     * @return list<array<string,mixed>>
     */
    public function searchEmails(string $folder, array $criteria, int $limit = 20): array
    {
        $limit = max(1, min(100, $limit));
        $this->selectFolder($folder, true);

        $parts = [];
        $needUtf8 = false;
        foreach ([['FROM', 'from'], ['TO', 'to'], ['SUBJECT', 'subject'], ['TEXT', 'text']] as [$kw, $key]) {
            $value = isset($criteria[$key]) ? (string) $criteria[$key] : '';
            if ($value !== '') {
                $parts[] = ['text', ' ' . $kw . ' '];
                $parts[] = ['literal', $value];
                if (preg_match('/[^\x20-\x7e]/', $value)) {
                    $needUtf8 = true;
                }
            }
        }
        foreach ([['SINCE', 'since'], ['BEFORE', 'before']] as [$kw, $key]) {
            $value = isset($criteria[$key]) ? (string) $criteria[$key] : '';
            if ($value !== '') {
                $parts[] = ['text', ' ' . $kw . ' ' . self::imapDate($value)];
            }
        }
        if (!empty($criteria['unseen'])) {
            $parts[] = ['text', ' UNSEEN'];
        }
        if ($parts === []) {
            $parts[] = ['text', ' ALL'];
        }
        array_unshift($parts, ['text', 'UID SEARCH' . ($needUtf8 ? ' CHARSET UTF-8' : '')]);

        $lines = $this->sendCommandParts($parts);
        $uids = [];
        foreach ($lines as $line) {
            if (preg_match('/^\* SEARCH\b(.*)$/i', $line['text'], $m)) {
                foreach (preg_split('/\s+/', trim($m[1]), -1, PREG_SPLIT_NO_EMPTY) ?: [] as $u) {
                    if (ctype_digit($u)) {
                        $uids[] = (int) $u;
                    }
                }
            }
        }
        if ($uids === []) {
            return [];
        }
        sort($uids);
        $uids = array_slice($uids, -$limit); // les `limit` UID les plus récents

        $lines = $this->sendCommand(sprintf(
            'UID FETCH %s (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])',
            implode(',', $uids)
        ));
        $emails = $this->parseEnvelopeFetch($lines);
        usort($emails, static fn (array $a, array $b): int => $b['uid'] <=> $a['uid']);
        return $emails;
    }

    /**
     * Récupère et parse le message complet (UID FETCH BODY.PEEK[]).
     *
     * @return array<string,mixed>
     */
    public function readEmail(string $folder, int $uid): array
    {
        $this->selectFolder($folder, true);
        $lines = $this->sendCommand(sprintf('UID FETCH %d (BODY.PEEK[])', $uid));

        $raw = null;
        foreach ($lines as $line) {
            if (!preg_match('/^\* \d+ FETCH /i', $line['text']) || $line['literals'] === []) {
                continue;
            }
            $lit = $line['literals'][count($line['literals']) - 1];
            $raw = substr($line['text'], $lit['offset'], $lit['length']);
            break;
        }
        if ($raw === null) {
            throw new ImapException(sprintf("Message UID %d introuvable dans le dossier '%s'.", $uid, $folder));
        }

        $parsed = MimeMessage::parse($raw);
        return array_merge(['uid' => $uid, 'folder' => $folder], $parsed);
    }

    /** Ajoute ou retire le flag \Seen. */
    public function markEmail(string $folder, int $uid, bool $seen): void
    {
        $this->selectFolder($folder, false);
        $this->sendCommand(sprintf('UID STORE %d %sFLAGS (\\Seen)', $uid, $seen ? '+' : '-'));
    }

    // ------------------------------------------------------------------
    // Parsing des réponses FETCH d'en-têtes
    // ------------------------------------------------------------------

    /**
     * @param list<array{text:string,literals:list<array{offset:int,length:int}>}> $lines
     * @return list<array<string,mixed>>
     */
    private function parseEnvelopeFetch(array $lines): array
    {
        $emails = [];
        foreach ($lines as $line) {
            $text = $line['text'];
            if (!preg_match('/^\* (\d+) FETCH /i', $text, $m)) {
                continue;
            }
            $seq = (int) $m[1];

            // Métadonnées : on analyse le texte HORS plages littérales pour ne pas
            // matcher par accident à l'intérieur du bloc d'en-têtes.
            $meta = $text;
            $headerRaw = '';
            if ($line['literals'] !== []) {
                $lit = $line['literals'][count($line['literals']) - 1];
                $headerRaw = substr($text, $lit['offset'], $lit['length']);
                $meta = substr($text, 0, $lit['offset']) . substr($text, $lit['offset'] + $lit['length']);
            }

            $uid = preg_match('/\bUID (\d+)/i', $meta, $mu) ? (int) $mu[1] : null;
            $size = preg_match('/\bRFC822\.SIZE (\d+)/i', $meta, $ms) ? (int) $ms[1] : null;
            $flagsStr = preg_match('/\bFLAGS \(([^)]*)\)/i', $meta, $mf) ? $mf[1] : '';
            $seen = stripos($flagsStr, '\\Seen') !== false;

            if ($uid === null) {
                continue;
            }

            $h = MimeMessage::parseHeaderBlock($headerRaw);
            $emails[] = [
                'uid' => $uid,
                'seq' => $seq,
                'date' => MimeMessage::decodeHeader($h['date'] ?? null),
                'from' => MimeMessage::decodeHeader($h['from'] ?? null),
                'to' => MimeMessage::decodeHeader($h['to'] ?? null),
                'subject' => MimeMessage::decodeHeader($h['subject'] ?? null),
                'message_id' => isset($h['message-id']) ? trim($h['message-id']) : null,
                'seen' => $seen,
                'size' => $size,
            ];
        }
        return $emails;
    }

    // ------------------------------------------------------------------
    // Mécanique protocolaire
    // ------------------------------------------------------------------

    /**
     * Envoie une commande taguée et lit la réponse jusqu'à la ligne taguée finale.
     *
     * @return list<array{text:string,literals:list<array{offset:int,length:int}>}>
     */
    private function sendCommand(string $cmd): array
    {
        $tag = 'A' . (++$this->tagCounter);
        $this->writeRaw($tag . ' ' . $cmd . "\r\n");
        return $this->readUntilTagged($tag);
    }

    /**
     * Envoie une commande contenant des littéraux en émission : chaque littéral
     * est annoncé par {N}, attend la continuation `+` du serveur, puis les N
     * octets bruts sont envoyés et la commande se poursuit.
     *
     * @param list<array{0:'text'|'literal',1:string}> $parts
     * @return list<array{text:string,literals:list<array{offset:int,length:int}>}>
     */
    private function sendCommandParts(array $parts): array
    {
        $tag = 'A' . (++$this->tagCounter);
        $buf = $tag . ' ';
        foreach ($parts as [$kind, $value]) {
            if ($kind === 'text') {
                $buf .= $value;
            } else {
                $buf .= '{' . strlen($value) . "}\r\n";
                $this->writeRaw($buf);
                $this->expectContinuation();
                $buf = $value;
            }
        }
        $this->writeRaw($buf . "\r\n");
        return $this->readUntilTagged($tag);
    }

    /**
     * @return list<array{text:string,literals:list<array{offset:int,length:int}>}>
     */
    private function readUntilTagged(string $tag): array
    {
        $lines = [];
        while (true) {
            $line = $this->readLogicalLine();
            if ($line === null) {
                throw new ImapException('Connexion IMAP interrompue pendant la lecture de la réponse.');
            }
            if (preg_match('/^' . preg_quote($tag, '/') . ' (OK|NO|BAD)\b(.*)$/i', $line['text'], $m)) {
                if (strtoupper($m[1]) !== 'OK') {
                    throw new ImapException(trim($m[1] . $m[2]));
                }
                return $lines;
            }
            $lines[] = $line;
        }
    }

    /**
     * Lit une « ligne logique » : une ligne CRLF, plus le contenu brut de tout
     * littéral {N} annoncé en fin de ligne (et la suite de la ligne après).
     *
     * @return array{text:string,literals:list<array{offset:int,length:int}>}|null
     */
    private function readLogicalLine(): ?array
    {
        $raw = fgets($this->sock);
        if ($raw === false) {
            return null;
        }
        $text = rtrim($raw, "\r\n");
        $literals = [];

        while (preg_match('/\{(\d+)\}$/', $text, $m, PREG_OFFSET_CAPTURE)) {
            $matchPos = (int) $m[0][1];
            $lastEnd = 0;
            if ($literals !== []) {
                $last = $literals[count($literals) - 1];
                $lastEnd = $last['offset'] + $last['length'];
            }
            if ($matchPos < $lastEnd) {
                // Le {N} apparent est à l'intérieur d'un littéral déjà consommé : stop.
                break;
            }
            $n = (int) $m[1][0];
            $text = substr($text, 0, $matchPos);
            $data = $this->readBytes($n);
            $literals[] = ['offset' => strlen($text), 'length' => $n];
            $text .= $data;

            $next = fgets($this->sock);
            if ($next === false) {
                throw new ImapException('Connexion IMAP interrompue pendant la lecture d\'un littéral.');
            }
            $text .= rtrim($next, "\r\n");
        }

        return ['text' => $text, 'literals' => $literals];
    }

    private function readBytes(int $n): string
    {
        $data = '';
        while (strlen($data) < $n) {
            $chunk = fread($this->sock, $n - strlen($data));
            if ($chunk === false || $chunk === '') {
                throw new ImapException(sprintf(
                    'Connexion IMAP interrompue : %d octets reçus sur les %d attendus.',
                    strlen($data),
                    $n
                ));
            }
            $data .= $chunk;
        }
        return $data;
    }

    private function expectContinuation(): void
    {
        $line = fgets($this->sock);
        if ($line === false || !str_starts_with(ltrim($line), '+')) {
            throw new ImapException(
                'Réponse de continuation IMAP (+) attendue, reçu : ' . trim((string) $line)
            );
        }
    }

    private function writeRaw(string $data): void
    {
        if (!is_resource($this->sock)) {
            throw new ImapException('Connexion IMAP non établie.');
        }
        $total = strlen($data);
        $written = 0;
        while ($written < $total) {
            $n = fwrite($this->sock, substr($data, $written));
            if ($n === false || $n === 0) {
                throw new ImapException('Écriture sur la connexion IMAP impossible (connexion fermée ?).');
            }
            $written += $n;
        }
    }

    // ------------------------------------------------------------------
    // Utilitaires
    // ------------------------------------------------------------------

    /** Quote un nom de mailbox (échappe \ et ") pour les commandes IMAP. */
    private static function quoteMailbox(string $name): string
    {
        return '"' . addcslashes($name, "\\\"") . '"';
    }

    /** Encode en modified-UTF-7 si le nom fourni contient du non-ASCII. */
    private static function normalizeFolderName(string $folder): string
    {
        if (preg_match('/[^\x20-\x7e]/', $folder)) {
            return self::mUtf7Encode($folder);
        }
        return $folder;
    }

    /** Retire les guillemets d'une quoted-string IMAP et déséchappe \" et \\. */
    private static function dequote(string $s): string
    {
        if (strlen($s) >= 2 && $s[0] === '"' && substr($s, -1) === '"') {
            $s = substr($s, 1, -1);
        }
        return preg_replace('/\\\\(["\\\\])/', '$1', $s) ?? $s;
    }

    /** Convertit YYYY-MM-DD en format de date IMAP (ex. 7-Jul-2026). */
    private static function imapDate(string $ymd): string
    {
        $dt = DateTimeImmutable::createFromFormat('!Y-m-d', $ymd);
        if ($dt === false) {
            throw new ImapException(sprintf("Date invalide : '%s' (format attendu : YYYY-MM-DD).", $ymd));
        }
        return $dt->format('j-M-Y'); // les noms de mois PHP "M" sont toujours en anglais
    }

    /** Décode un nom de dossier IMAP modified-UTF-7 (RFC 3501 §5.1.3) vers UTF-8. */
    public static function mUtf7Decode(string $s): string
    {
        $out = '';
        $len = strlen($s);
        for ($i = 0; $i < $len; $i++) {
            $c = $s[$i];
            if ($c !== '&') {
                $out .= $c;
                continue;
            }
            $end = strpos($s, '-', $i + 1);
            if ($end === false) {
                $out .= substr($s, $i);
                break;
            }
            $b64 = substr($s, $i + 1, $end - $i - 1);
            if ($b64 === '') {
                $out .= '&'; // "&-" est l'échappement du caractère &
            } else {
                $padded = $b64 . str_repeat('=', (4 - strlen($b64) % 4) % 4);
                $bin = base64_decode(strtr($padded, ',', '/'), true);
                $decoded = false;
                if ($bin !== false) {
                    $decoded = self::utf16beToUtf8($bin);
                }
                $out .= $decoded !== false ? $decoded : '&' . $b64 . '-';
            }
            $i = $end;
        }
        return $out;
    }

    /** Encode un nom de dossier UTF-8 vers modified-UTF-7 (RFC 3501 §5.1.3). */
    public static function mUtf7Encode(string $s): string
    {
        $chars = preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY);
        if ($chars === false) {
            return $s; // pas de l'UTF-8 valide : on envoie tel quel
        }
        $out = '';
        $buffer = '';
        $flush = static function () use (&$out, &$buffer): void {
            if ($buffer === '') {
                return;
            }
            $bin = self::utf8ToUtf16be($buffer);
            $out .= '&' . strtr(rtrim(base64_encode($bin), '='), '/', ',') . '-';
            $buffer = '';
        };
        foreach ($chars as $ch) {
            $code = strlen($ch) === 1 ? ord($ch) : 256;
            if ($code >= 0x20 && $code <= 0x7e) {
                $flush();
                $out .= $ch === '&' ? '&-' : $ch;
            } else {
                $buffer .= $ch;
            }
        }
        $flush();
        return $out;
    }

    /** @return string|false */
    private static function utf16beToUtf8(string $bin)
    {
        if (function_exists('mb_convert_encoding')) {
            try {
                $r = @mb_convert_encoding($bin, 'UTF-8', 'UTF-16BE');
                if (is_string($r)) {
                    return $r;
                }
            } catch (ValueError) {
                // continue avec iconv
            }
        }
        $r = @iconv('UTF-16BE', 'UTF-8//IGNORE', $bin);
        return is_string($r) ? $r : false;
    }

    private static function utf8ToUtf16be(string $utf8): string
    {
        if (function_exists('mb_convert_encoding')) {
            try {
                $r = @mb_convert_encoding($utf8, 'UTF-16BE', 'UTF-8');
                if (is_string($r)) {
                    return $r;
                }
            } catch (ValueError) {
                // continue avec iconv
            }
        }
        $r = @iconv('UTF-8', 'UTF-16BE//IGNORE', $utf8);
        return is_string($r) ? $r : '';
    }
}
