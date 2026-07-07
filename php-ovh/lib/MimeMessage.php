<?php
/**
 * Parseur MIME minimal, sans dépendance.
 *
 * Gère : séparation en-têtes/corps (CRLF ou LF), unfolding, décodage RFC 2047
 * (iconv_mime_decode), multipart récursif, Content-Transfer-Encoding
 * (base64 / quoted-printable / 7bit / 8bit), conversion de charset vers UTF-8
 * avec fallbacks tolérants, extraction du texte (text/plain prioritaire,
 * sinon text/html converti en texte) et inventaire des pièces jointes
 * (métadonnées seulement, jamais le contenu).
 */

declare(strict_types=1);

final class MimeMessage
{
    /**
     * Parse un message brut complet (RFC 5322 + MIME).
     *
     * @return array{
     *   subject:?string, from:?string, to:?string, cc:?string, date:?string,
     *   message_id:?string, in_reply_to:?string, text:string,
     *   attachments:list<array{filename:string,content_type:string,size:int}>
     * }
     */
    public static function parse(string $raw): array
    {
        [$headerBlock, $body] = self::splitHeadersBody($raw);
        $headers = self::parseHeaderBlock($headerBlock);

        $leaves = [];
        self::collectParts($headers, $body, $leaves, 0);

        // Corps texte : première feuille text/plain non-pièce-jointe,
        // sinon première feuille text/html convertie en texte.
        $text = '';
        foreach ($leaves as $leaf) {
            if (!$leaf['is_attachment'] && $leaf['type'] === 'text' && $leaf['subtype'] === 'plain') {
                $text = $leaf['text'];
                break;
            }
        }
        if ($text === '') {
            foreach ($leaves as $leaf) {
                if (!$leaf['is_attachment'] && $leaf['type'] === 'text' && $leaf['subtype'] === 'html') {
                    $text = self::htmlToText($leaf['text']);
                    break;
                }
            }
        }

        $attachments = [];
        foreach ($leaves as $leaf) {
            if ($leaf['is_attachment']) {
                $attachments[] = [
                    'filename' => $leaf['filename'] !== '' ? $leaf['filename'] : '(sans nom)',
                    'content_type' => $leaf['type'] . '/' . $leaf['subtype'],
                    'size' => $leaf['size'],
                ];
            }
        }

        return [
            'subject' => self::decodeHeader($headers['subject'] ?? null),
            'from' => self::decodeHeader($headers['from'] ?? null),
            'to' => self::decodeHeader($headers['to'] ?? null),
            'cc' => self::decodeHeader($headers['cc'] ?? null),
            'date' => isset($headers['date']) ? trim($headers['date']) : null,
            'message_id' => isset($headers['message-id']) ? trim($headers['message-id']) : null,
            'in_reply_to' => isset($headers['in-reply-to']) ? trim($headers['in-reply-to']) : null,
            'text' => $text,
            'attachments' => $attachments,
        ];
    }

    // ------------------------------------------------------------------
    // En-têtes
    // ------------------------------------------------------------------

    /**
     * Unfold + parse d'un bloc d'en-têtes bruts en tableau [nom-minuscule => valeur brute].
     * En cas d'en-tête répété, la dernière occurrence est conservée.
     *
     * @return array<string,string>
     */
    public static function parseHeaderBlock(string $raw): array
    {
        $raw = preg_replace("/\r?\n[ \t]+/", ' ', $raw) ?? $raw;
        $out = [];
        foreach (preg_split("/\r?\n/", $raw) ?: [] as $line) {
            $pos = strpos($line, ':');
            if ($pos === false || $pos === 0) {
                continue;
            }
            $name = strtolower(trim(substr($line, 0, $pos)));
            $out[$name] = trim(substr($line, $pos + 1));
        }
        return $out;
    }

    /** Décode une valeur d'en-tête RFC 2047 vers UTF-8 (tolérant aux erreurs). */
    public static function decodeHeader(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $decoded = @iconv_mime_decode($value, ICONV_MIME_DECODE_CONTINUE_ON_ERROR, 'UTF-8');
        $result = $decoded !== false ? $decoded : $value;
        return trim($result);
    }

    // ------------------------------------------------------------------
    // Corps / multipart
    // ------------------------------------------------------------------

    /** @return array{0:string,1:string} */
    private static function splitHeadersBody(string $raw): array
    {
        $parts = preg_split("/\r?\n\r?\n/", $raw, 2);
        if ($parts === false || count($parts) < 2) {
            return [$raw, ''];
        }
        return [$parts[0], $parts[1]];
    }

    /**
     * Descend récursivement dans les multiparts et collecte les feuilles.
     *
     * @param array<string,string> $headers En-têtes (clés minuscules) de la partie courante
     * @param list<array<string,mixed>> $leaves Accumulateur (par référence)
     */
    private static function collectParts(array $headers, string $body, array &$leaves, int $depth): void
    {
        if ($depth > 10) {
            return; // garde-fou contre les multiparts pathologiques
        }

        $ct = self::parseContentType($headers['content-type'] ?? 'text/plain; charset=us-ascii');

        if ($ct['type'] === 'multipart' && isset($ct['params']['boundary']) && $ct['params']['boundary'] !== '') {
            foreach (self::splitByBoundary($body, $ct['params']['boundary']) as $partRaw) {
                [$ph, $pb] = self::splitHeadersBody($partRaw);
                self::collectParts(self::parseHeaderBlock($ph), $pb, $leaves, $depth + 1);
            }
            return;
        }

        // Partie simple (feuille)
        $cte = strtolower(trim($headers['content-transfer-encoding'] ?? ''));
        $decoded = self::decodeTransferEncoding($body, $cte);

        [$isAttachment, $filename] = self::attachmentInfo($headers, $ct);

        $textContent = '';
        if (!$isAttachment && $ct['type'] === 'text') {
            $textContent = self::toUtf8($decoded, $ct['params']['charset'] ?? null);
        }

        $leaves[] = [
            'type' => $ct['type'],
            'subtype' => $ct['subtype'],
            'is_attachment' => $isAttachment,
            'filename' => $filename,
            'size' => strlen($decoded),
            'text' => $textContent,
        ];
    }

    /**
     * Découpe un corps multipart sur --boundary ; s'arrête à --boundary--.
     *
     * @return list<string>
     */
    private static function splitByBoundary(string $body, string $boundary): array
    {
        $chunks = explode('--' . $boundary, $body);
        // chunks[0] = préambule (ignoré) ; le dernier segment utile précède "--boundary--"
        $parts = [];
        $count = count($chunks);
        for ($i = 1; $i < $count; $i++) {
            $chunk = $chunks[$i];
            if (str_starts_with($chunk, '--')) {
                break; // marqueur de fin --boundary--
            }
            // Retirer le CRLF qui suit le délimiteur et celui qui précède le suivant
            $chunk = preg_replace('/^\r?\n/', '', $chunk) ?? $chunk;
            $chunk = preg_replace('/\r?\n$/', '', $chunk) ?? $chunk;
            if ($chunk !== '') {
                $parts[] = $chunk;
            }
        }
        return $parts;
    }

    /**
     * @return array{type:string,subtype:string,params:array<string,string>}
     */
    public static function parseContentType(string $value): array
    {
        $semi = strpos($value, ';');
        $typePart = strtolower(trim($semi === false ? $value : substr($value, 0, $semi)));
        $type = 'text';
        $subtype = 'plain';
        if ($typePart !== '' && strpos($typePart, '/') !== false) {
            [$type, $subtype] = explode('/', $typePart, 2);
        }

        $params = [];
        if ($semi !== false) {
            $paramStr = substr($value, $semi + 1);
            if (preg_match_all(
                '/([a-zA-Z0-9\-_*]+)\s*=\s*("(?:[^"\\\\]|\\\\.)*"|[^;]*)/',
                $paramStr,
                $matches,
                PREG_SET_ORDER
            )) {
                foreach ($matches as $m) {
                    $pname = strtolower($m[1]);
                    $pval = trim($m[2]);
                    if ($pval !== '' && $pval[0] === '"') {
                        $pval = substr($pval, 1, -1);
                        $pval = preg_replace('/\\\\(.)/', '$1', $pval) ?? $pval;
                    }
                    $params[$pname] = $pval;
                }
            }
        }
        return ['type' => $type, 'subtype' => $subtype, 'params' => $params];
    }

    /**
     * Détermine si la partie est une pièce jointe et son nom de fichier.
     *
     * @param array<string,string> $headers
     * @param array{type:string,subtype:string,params:array<string,string>} $ct
     * @return array{0:bool,1:string}
     */
    private static function attachmentInfo(array $headers, array $ct): array
    {
        $disposition = '';
        $dparams = [];
        if (isset($headers['content-disposition'])) {
            $cd = self::parseContentType($headers['content-disposition']);
            // parseContentType lit "token; params" : le token est dans type (avant un éventuel /)
            $disposition = strtolower(trim(explode(';', $headers['content-disposition'], 2)[0]));
            $dparams = $cd['params'];
        }

        $filename = $dparams['filename'] ?? $ct['params']['name'] ?? '';
        // RFC 2231 : filename*=UTF-8''...%20...
        $ext = $dparams['filename*'] ?? $ct['params']['name*'] ?? '';
        if ($ext !== '' && preg_match("/^([^']*)'[^']*'(.*)$/", $ext, $m)) {
            $charset = $m[1] !== '' ? $m[1] : 'UTF-8';
            $filename = self::toUtf8(rawurldecode($m[2]), $charset);
        } elseif ($filename !== '') {
            $filename = (string) self::decodeHeader($filename);
        }

        $isAttachment = $disposition === 'attachment' || $filename !== '';
        return [$isAttachment, $filename];
    }

    private static function decodeTransferEncoding(string $body, string $cte): string
    {
        switch ($cte) {
            case 'base64':
                $decoded = base64_decode($body, false);
                return $decoded !== false ? $decoded : $body;
            case 'quoted-printable':
                return quoted_printable_decode($body);
            default: // 7bit, 8bit, binary, vide...
                return $body;
        }
    }

    /** Convertit vers UTF-8 en tolérant les charsets inconnus/mal déclarés. */
    public static function toUtf8(string $s, ?string $charset): string
    {
        if ($s === '') {
            return '';
        }
        $charset = strtoupper(trim((string) $charset));
        if ($charset === '' || $charset === 'UTF-8' || $charset === 'UTF8' || $charset === 'US-ASCII' || $charset === 'ASCII') {
            if (preg_match('//u', $s)) {
                return $s; // déjà de l'UTF-8 valide
            }
            $charset = 'ISO-8859-1'; // déclaration mensongère : fallback raisonnable
        }
        if (function_exists('mb_convert_encoding')) {
            try {
                $out = @mb_convert_encoding($s, 'UTF-8', $charset);
                if (is_string($out) && $out !== '') {
                    return $out;
                }
            } catch (ValueError) {
                // charset inconnu de mbstring : essayer iconv
            }
        }
        $out = @iconv($charset, 'UTF-8//IGNORE', $s);
        if (is_string($out)) {
            return $out;
        }
        $out = @iconv('ISO-8859-1', 'UTF-8//IGNORE', $s);
        return is_string($out) ? $out : $s;
    }

    /** Conversion HTML -> texte lisible : strip_tags + entités + espaces normalisés. */
    private static function htmlToText(string $html): string
    {
        // Supprimer les blocs non textuels
        $html = preg_replace('#<(script|style|head)\b[^>]*>.*?</\1>#is', '', $html) ?? $html;
        // Sauts de ligne pour les principales balises de bloc
        $html = preg_replace('#<(?:br|/p|/div|/tr|/li|/h[1-6]|/blockquote)\b[^>]*>#i', "\n", $html) ?? $html;
        $text = strip_tags($html);
        $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        // Normalisation des espaces
        $text = str_replace("\xc2\xa0", ' ', $text); // espaces insécables
        $text = preg_replace('/[ \t]+/', ' ', $text) ?? $text;
        $text = preg_replace('/ *\n */', "\n", $text) ?? $text;
        $text = preg_replace('/\n{3,}/', "\n\n", $text) ?? $text;
        return trim($text);
    }
}
