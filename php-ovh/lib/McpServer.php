<?php
/**
 * Dispatcher JSON-RPC 2.0 / MCP.
 *
 * Traite un message JSON-RPC décodé et retourne le tableau de réponse,
 * ou null pour une notification (le point d'entrée renverra alors HTTP 202).
 *
 * Méthodes supportées : initialize, ping, tools/list, tools/call,
 * notifications/* (ignorées). Les erreurs d'EXÉCUTION d'un outil ne sont pas
 * des erreurs JSON-RPC : elles sont retournées dans result.isError = true,
 * conformément à la spec MCP. Les arguments invalides restent des -32602.
 */

declare(strict_types=1);

final class McpServer
{
    private const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
    private const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
    private const SERVER_NAME = 'Mail MCP Server (IMAP/SMTP)';
    private const SERVER_VERSION = '1.0.0';

    public function __construct(private array $config)
    {
    }

    /**
     * @param array<string,mixed> $request Message JSON-RPC décodé (assoc)
     * @return array<string,mixed>|null Réponse JSON-RPC, ou null si notification
     */
    public function handle(array $request): ?array
    {
        $isNotification = !array_key_exists('id', $request);
        $id = $request['id'] ?? null;
        $method = $request['method'] ?? null;
        $params = $request['params'] ?? [];
        if (!is_array($params)) {
            $params = [];
        }

        if (!is_string($method) || $method === '') {
            return $isNotification ? null : $this->error($id, -32600, 'Invalid Request');
        }

        // Toute notification entrante (notifications/initialized, etc.) est acquittée sans réponse.
        if (str_starts_with($method, 'notifications/')) {
            return null;
        }

        try {
            switch ($method) {
                case 'initialize':
                    $result = $this->initialize($params);
                    break;
                case 'ping':
                    $result = new stdClass();
                    break;
                case 'tools/list':
                    $result = $this->toolsList();
                    break;
                case 'tools/call':
                    $result = $this->toolsCall($params);
                    break;
                default:
                    return $isNotification ? null : $this->error($id, -32601, 'Method not found: ' . $method);
            }
        } catch (InvalidArgumentException $e) {
            return $isNotification ? null : $this->error($id, -32602, $e->getMessage());
        }

        return $isNotification ? null : ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    }

    /** @return array<string,mixed> */
    private function error(mixed $id, int $code, string $message): array
    {
        return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $message]];
    }

    // ------------------------------------------------------------------
    // initialize / tools/list
    // ------------------------------------------------------------------

    /** @return array<string,mixed> */
    private function initialize(array $params): array
    {
        $requested = $params['protocolVersion'] ?? null;
        $protocolVersion = in_array($requested, self::PROTOCOL_VERSIONS, true)
            ? $requested
            : self::DEFAULT_PROTOCOL_VERSION;

        return [
            'protocolVersion' => $protocolVersion,
            'capabilities' => ['tools' => new stdClass()],
            'serverInfo' => [
                'name' => self::SERVER_NAME,
                'version' => self::SERVER_VERSION,
            ],
        ];
    }

    /** @return array<string,mixed> */
    private function toolsList(): array
    {
        return ['tools' => [
            [
                'name' => 'list_folders',
                'description' => 'List all IMAP folders with their message and unseen counts.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => new stdClass(),
                ],
            ],
            [
                'name' => 'list_emails',
                'description' => 'List the most recent emails in a folder, newest first. Returns uid, from, to, subject, date, seen flag and size for each email.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'folder' => [
                            'type' => 'string',
                            'description' => 'IMAP folder path (default: INBOX)',
                            'default' => 'INBOX',
                        ],
                        'limit' => [
                            'type' => 'integer',
                            'description' => 'Maximum number of emails to return (default 20, max 100)',
                            'default' => 20,
                        ],
                        'offset' => [
                            'type' => 'integer',
                            'description' => 'Number of most recent emails to skip, for pagination (default 0)',
                            'default' => 0,
                        ],
                    ],
                ],
            ],
            [
                'name' => 'read_email',
                'description' => 'Read a full email by UID: headers, plain-text body and attachment metadata.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'folder' => [
                            'type' => 'string',
                            'description' => 'IMAP folder path (default: INBOX)',
                            'default' => 'INBOX',
                        ],
                        'uid' => [
                            'type' => 'integer',
                            'description' => 'IMAP UID of the email (as returned by list_emails or search_emails)',
                        ],
                    ],
                    'required' => ['uid'],
                ],
            ],
            [
                'name' => 'search_emails',
                'description' => 'Search emails in a folder using IMAP SEARCH criteria. All criteria are combined with AND.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'folder' => [
                            'type' => 'string',
                            'description' => 'IMAP folder path (default: INBOX)',
                            'default' => 'INBOX',
                        ],
                        'from' => [
                            'type' => 'string',
                            'description' => 'Match emails whose From header contains this text',
                        ],
                        'to' => [
                            'type' => 'string',
                            'description' => 'Match emails whose To header contains this text',
                        ],
                        'subject' => [
                            'type' => 'string',
                            'description' => 'Match emails whose Subject contains this text',
                        ],
                        'text' => [
                            'type' => 'string',
                            'description' => 'Match emails containing this text anywhere (headers or body)',
                        ],
                        'since' => [
                            'type' => 'string',
                            'description' => 'Only emails on or after this date, format YYYY-MM-DD',
                        ],
                        'before' => [
                            'type' => 'string',
                            'description' => 'Only emails strictly before this date, format YYYY-MM-DD',
                        ],
                        'unseen' => [
                            'type' => 'boolean',
                            'description' => 'Only unread emails',
                        ],
                        'limit' => [
                            'type' => 'integer',
                            'description' => 'Maximum number of emails to return (default 20, max 100)',
                            'default' => 20,
                        ],
                    ],
                ],
            ],
            [
                'name' => 'send_email',
                'description' => 'Send an email via SMTP. Provide body (plain text) and/or html for an HTML message; at least one is required. Optionally attach files. Use in_reply_to (Message-ID) to reply within an existing thread.',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'to' => [
                            'type' => 'string',
                            'description' => 'Recipient email address(es), comma-separated',
                        ],
                        'subject' => [
                            'type' => 'string',
                            'description' => 'Email subject',
                        ],
                        'body' => [
                            'type' => 'string',
                            'description' => 'Plain-text body. Optional if html is provided; sent as the text/plain part.',
                        ],
                        'html' => [
                            'type' => 'string',
                            'description' => 'HTML body. Optional if body is provided. When both are given, they are sent as multipart/alternative.',
                        ],
                        'cc' => [
                            'type' => 'string',
                            'description' => 'CC recipient(s), comma-separated',
                        ],
                        'bcc' => [
                            'type' => 'string',
                            'description' => 'BCC recipient(s), comma-separated',
                        ],
                        'in_reply_to' => [
                            'type' => 'string',
                            'description' => 'Message-ID of the email being replied to (sets In-Reply-To and References headers)',
                        ],
                        'attachments' => [
                            'type' => 'array',
                            'description' => 'Files to attach to the email',
                            'items' => [
                                'type' => 'object',
                                'properties' => [
                                    'filename' => [
                                        'type' => 'string',
                                        'description' => 'File name shown to the recipient',
                                    ],
                                    'content' => [
                                        'type' => 'string',
                                        'description' => 'File content, Base64-encoded',
                                    ],
                                    'content_type' => [
                                        'type' => 'string',
                                        'description' => 'MIME type, e.g. "application/pdf" (default: application/octet-stream)',
                                    ],
                                ],
                                'required' => ['filename', 'content'],
                            ],
                        ],
                    ],
                    'required' => ['to', 'subject'],
                ],
            ],
            [
                'name' => 'mark_email',
                'description' => 'Mark an email as read (seen=true) or unread (seen=false).',
                'inputSchema' => [
                    'type' => 'object',
                    'properties' => [
                        'folder' => [
                            'type' => 'string',
                            'description' => 'IMAP folder path (default: INBOX)',
                            'default' => 'INBOX',
                        ],
                        'uid' => [
                            'type' => 'integer',
                            'description' => 'IMAP UID of the email',
                        ],
                        'seen' => [
                            'type' => 'boolean',
                            'description' => 'true to mark as read, false to mark as unread',
                        ],
                    ],
                    'required' => ['uid', 'seen'],
                ],
            ],
        ]];
    }

    // ------------------------------------------------------------------
    // tools/call
    // ------------------------------------------------------------------

    /** @return array<string,mixed> */
    private function toolsCall(array $params): array
    {
        $name = $params['name'] ?? null;
        if (!is_string($name) || $name === '') {
            throw new InvalidArgumentException('Invalid params: missing tool name');
        }
        $args = $params['arguments'] ?? [];
        if (!is_array($args)) {
            throw new InvalidArgumentException('Invalid params: arguments must be an object');
        }

        // Validation des arguments AVANT exécution : une InvalidArgumentException
        // levée ici remonte en erreur JSON-RPC -32602. Les erreurs pendant
        // l'exécution (IMAP/SMTP/réseau) deviennent un résultat isError=true.
        $runner = match ($name) {
            'list_folders' => $this->prepareListFolders($args),
            'list_emails' => $this->prepareListEmails($args),
            'read_email' => $this->prepareReadEmail($args),
            'search_emails' => $this->prepareSearchEmails($args),
            'send_email' => $this->prepareSendEmail($args),
            'mark_email' => $this->prepareMarkEmail($args),
            default => throw new InvalidArgumentException('Unknown tool: ' . $name),
        };

        try {
            $data = $runner();
            return ['content' => [[
                'type' => 'text',
                'text' => json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
            ]]];
        } catch (Throwable $e) {
            error_log(sprintf('[mcp] tool "%s" failed: %s', $name, $e->getMessage()));
            return [
                'content' => [['type' => 'text', 'text' => 'Error: ' . $e->getMessage()]],
                'isError' => true,
            ];
        }
    }

    // --- Préparation (validation) puis exécution de chaque outil -----------

    private function prepareListFolders(array $args): Closure
    {
        return function (): array {
            $imap = $this->openImap();
            try {
                $folders = $imap->listFolders();
            } finally {
                $imap->logout();
            }
            return ['folders' => $folders, 'count' => count($folders)];
        };
    }

    private function prepareListEmails(array $args): Closure
    {
        $folder = $this->argString($args, 'folder', 'INBOX');
        $limit = $this->argInt($args, 'limit', 20, 1, 100);
        $offset = $this->argInt($args, 'offset', 0, 0, PHP_INT_MAX);

        return function () use ($folder, $limit, $offset): array {
            $imap = $this->openImap();
            try {
                $emails = $imap->listEmails($folder, $limit, $offset);
            } finally {
                $imap->logout();
            }
            return [
                'folder' => $folder,
                'offset' => $offset,
                'count' => count($emails),
                'emails' => $emails,
            ];
        };
    }

    private function prepareReadEmail(array $args): Closure
    {
        $folder = $this->argString($args, 'folder', 'INBOX');
        $uid = $this->argInt($args, 'uid', null, 1, PHP_INT_MAX);

        return function () use ($folder, $uid): array {
            $imap = $this->openImap();
            try {
                return $imap->readEmail($folder, $uid);
            } finally {
                $imap->logout();
            }
        };
    }

    private function prepareSearchEmails(array $args): Closure
    {
        $folder = $this->argString($args, 'folder', 'INBOX');
        $limit = $this->argInt($args, 'limit', 20, 1, 100);
        $criteria = [
            'from' => $this->argString($args, 'from', ''),
            'to' => $this->argString($args, 'to', ''),
            'subject' => $this->argString($args, 'subject', ''),
            'text' => $this->argString($args, 'text', ''),
            'since' => $this->argDate($args, 'since'),
            'before' => $this->argDate($args, 'before'),
            'unseen' => $this->argBool($args, 'unseen', false),
        ];

        return function () use ($folder, $criteria, $limit): array {
            $imap = $this->openImap();
            try {
                $emails = $imap->searchEmails($folder, $criteria, $limit);
            } finally {
                $imap->logout();
            }
            return [
                'folder' => $folder,
                'count' => count($emails),
                'emails' => $emails,
            ];
        };
    }

    private function prepareSendEmail(array $args): Closure
    {
        $to = $this->splitAddresses($this->argString($args, 'to', null));
        $subject = $this->argString($args, 'subject', null);
        $body = $this->argString($args, 'body', '');
        $html = $this->argString($args, 'html', '');
        $cc = $this->splitAddresses($this->argString($args, 'cc', ''));
        $bcc = $this->splitAddresses($this->argString($args, 'bcc', ''));
        $inReplyTo = $this->argString($args, 'in_reply_to', '');
        $attachments = $this->parseAttachments($args);

        if ($to === []) {
            throw new InvalidArgumentException("Invalid params: 'to' must contain at least one recipient address");
        }
        if (trim($body) === '' && trim($html) === '') {
            throw new InvalidArgumentException("Invalid params: provide at least one of 'body' (plain text) or 'html'");
        }

        $message = [
            'from_email' => $this->config['mail_from'],
            'from_name' => $this->config['mail_from_name'],
            'to' => $to,
            'cc' => $cc,
            'bcc' => $bcc,
            'subject' => $subject,
            'body' => $body !== '' ? $body : null,
            'html' => $html !== '' ? $html : null,
            'in_reply_to' => $inReplyTo !== '' ? $inReplyTo : null,
            'attachments' => $attachments,
        ];

        return function () use ($message): array {
            $smtp = new SmtpClient();
            $result = $smtp->send($this->config['smtp'], $message);
            return [
                'status' => 'sent',
                'message_id' => $result['message_id'],
                'accepted' => $result['accepted'],
            ];
        };
    }

    private function prepareMarkEmail(array $args): Closure
    {
        $folder = $this->argString($args, 'folder', 'INBOX');
        $uid = $this->argInt($args, 'uid', null, 1, PHP_INT_MAX);
        $seen = $this->argBool($args, 'seen', null);

        return function () use ($folder, $uid, $seen): array {
            $imap = $this->openImap();
            try {
                $imap->markEmail($folder, $uid, $seen);
            } finally {
                $imap->logout();
            }
            return ['status' => 'ok', 'folder' => $folder, 'uid' => $uid, 'seen' => $seen];
        };
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private function openImap(): ImapClient
    {
        $c = $this->config['imap'];
        $imap = new ImapClient($c['host'], (int) $c['port'], $c['encryption']);
        $imap->connect();
        $imap->login($c['user'], $c['password']);
        return $imap;
    }

    /**
     * @param string|null $default null = argument requis
     */
    private function argString(array $args, string $key, ?string $default): string
    {
        if (!array_key_exists($key, $args) || $args[$key] === null || $args[$key] === '') {
            if ($default === null) {
                throw new InvalidArgumentException("Invalid params: missing required argument '$key'");
            }
            return $default;
        }
        if (!is_string($args[$key]) && !is_numeric($args[$key])) {
            throw new InvalidArgumentException("Invalid params: argument '$key' must be a string");
        }
        return (string) $args[$key];
    }

    /**
     * @param int|null $default null = argument requis
     */
    private function argInt(array $args, string $key, ?int $default, int $min, int $max): int
    {
        if (!array_key_exists($key, $args) || $args[$key] === null || $args[$key] === '') {
            if ($default === null) {
                throw new InvalidArgumentException("Invalid params: missing required argument '$key'");
            }
            return $default;
        }
        $v = $args[$key];
        if (is_string($v) && preg_match('/^-?\d+$/', $v)) {
            $v = (int) $v;
        }
        if (!is_int($v)) {
            throw new InvalidArgumentException("Invalid params: argument '$key' must be an integer");
        }
        return max($min, min($max, $v));
    }

    /**
     * @param bool|null $default null = argument requis
     */
    private function argBool(array $args, string $key, ?bool $default): bool
    {
        if (!array_key_exists($key, $args) || $args[$key] === null) {
            if ($default === null) {
                throw new InvalidArgumentException("Invalid params: missing required argument '$key'");
            }
            return $default;
        }
        $v = $args[$key];
        if (is_bool($v)) {
            return $v;
        }
        if ($v === 'true' || $v === 1 || $v === '1') {
            return true;
        }
        if ($v === 'false' || $v === 0 || $v === '0') {
            return false;
        }
        throw new InvalidArgumentException("Invalid params: argument '$key' must be a boolean");
    }

    /**
     * Valide et normalise l'argument `attachments`.
     *
     * @return list<array{filename:string, content_b64:string, content_type:string}>
     */
    private function parseAttachments(array $args): array
    {
        if (!array_key_exists('attachments', $args)
            || $args['attachments'] === null
            || $args['attachments'] === []
        ) {
            return [];
        }
        $raw = $args['attachments'];
        if (!is_array($raw) || !array_is_list($raw)) {
            throw new InvalidArgumentException("Invalid params: 'attachments' must be an array of objects");
        }

        $out = [];
        foreach ($raw as $i => $att) {
            if (!is_array($att)) {
                throw new InvalidArgumentException("Invalid params: attachments[$i] must be an object");
            }
            $filename = $att['filename'] ?? '';
            if (!is_string($filename) || trim($filename) === '') {
                throw new InvalidArgumentException("Invalid params: attachments[$i].filename is required");
            }
            $content = $att['content'] ?? '';
            if (!is_string($content) || $content === '') {
                throw new InvalidArgumentException("Invalid params: attachments[$i].content (Base64) is required");
            }
            // Base64 possiblement transmis avec des retours à la ligne : on les
            // retire puis on valide en mode strict (rejet des caractères hors alphabet).
            $clean = preg_replace('/\s+/', '', $content) ?? '';
            if ($clean === '' || base64_decode($clean, true) === false) {
                throw new InvalidArgumentException("Invalid params: attachments[$i].content is not valid Base64");
            }
            $ctype = $att['content_type'] ?? '';
            if (!is_string($ctype)) {
                throw new InvalidArgumentException("Invalid params: attachments[$i].content_type must be a string");
            }

            $out[] = [
                'filename' => $filename,
                'content_b64' => $clean,
                'content_type' => trim($ctype),
            ];
        }
        return $out;
    }

    private function argDate(array $args, string $key): string
    {
        $v = $this->argString($args, $key, '');
        if ($v === '') {
            return '';
        }
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) || DateTimeImmutable::createFromFormat('!Y-m-d', $v) === false) {
            throw new InvalidArgumentException("Invalid params: argument '$key' must be a date in YYYY-MM-DD format");
        }
        return $v;
    }

    /** @return list<string> */
    private function splitAddresses(string $csv): array
    {
        $out = [];
        foreach (explode(',', $csv) as $addr) {
            $addr = trim($addr);
            if ($addr !== '') {
                $out[] = $addr;
            }
        }
        return $out;
    }
}
