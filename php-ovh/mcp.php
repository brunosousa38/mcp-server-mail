<?php
/**
 * Point d'entrée HTTP du serveur MCP Mail (IMAP/SMTP) — variante PHP pur.
 *
 * Transport MCP « Streamable HTTP » en mode réponse JSON simple :
 * - POST uniquement (GET/DELETE -> 405, conforme quand SSE n'est pas supporté) ;
 * - pas de session ni de flux SSE ;
 * - notifications JSON-RPC (sans "id") -> HTTP 202, corps vide ;
 * - authentification par token : Authorization: Bearer X ou ?token=X.
 */

declare(strict_types=1);

ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');

require __DIR__ . '/lib/Config.php';
require __DIR__ . '/lib/MimeMessage.php';
require __DIR__ . '/lib/ImapClient.php';
require __DIR__ . '/lib/SmtpClient.php';
require __DIR__ . '/lib/McpServer.php';

/** Émet une erreur JSON-RPC et termine la requête. */
function mcp_fail(mixed $id, int $code, string $message, int $httpStatus): never
{
    http_response_code($httpStatus);
    echo json_encode([
        'jsonrpc' => '2.0',
        'id' => $id,
        'error' => ['code' => $code, 'message' => $message],
    ]);
    exit;
}

// ---------------------------------------------------------------------------
// 1. Méthode HTTP : POST uniquement.
// ---------------------------------------------------------------------------
$httpMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($httpMethod !== 'POST') {
    header('Allow: POST');
    mcp_fail(null, -32000, 'Method not allowed', 405);
}

// ---------------------------------------------------------------------------
// 2. Configuration (nécessaire pour connaître le token attendu).
// ---------------------------------------------------------------------------
try {
    $config = Config::get();
} catch (Throwable $e) {
    error_log('[mcp] configuration error: ' . $e->getMessage());
    mcp_fail(null, -32603, 'Internal error', 500);
}

// ---------------------------------------------------------------------------
// 3. Authentification AVANT tout traitement.
//    Token présenté : en-tête Authorization (HTTP_AUTHORIZATION,
//    REDIRECT_HTTP_AUTHORIZATION ou getallheaders() — l'en-tête se perd
//    facilement en CGI/FastCGI chez OVH) OU ?token= en query string
//    (indispensable pour les connecteurs qui n'acceptent pas d'en-tête custom).
// ---------------------------------------------------------------------------
$authHeader = $_SERVER['HTTP_AUTHORIZATION']
    ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
    ?? null;
if (($authHeader === null || $authHeader === '') && function_exists('getallheaders')) {
    foreach (getallheaders() as $headerName => $headerValue) {
        if (strcasecmp((string) $headerName, 'Authorization') === 0) {
            $authHeader = $headerValue;
            break;
        }
    }
}

$presented = null;
if (is_string($authHeader) && preg_match('/^Bearer\s+(.+)$/i', trim($authHeader), $m)) {
    $presented = trim($m[1]);
} elseif (isset($_GET['token']) && is_string($_GET['token'])) {
    $presented = $_GET['token'];
}

$expected = (string) $config['mcp_auth_token'];
if (
    $presented === null
    || $presented === ''
    || !hash_equals(hash('sha256', $expected), hash('sha256', $presented))
) {
    header('WWW-Authenticate: Bearer realm="mcp", error="invalid_token"');
    mcp_fail(null, -32001, 'Unauthorized', 401);
}

// ---------------------------------------------------------------------------
// 4. Corps de la requête : JSON obligatoire.
// ---------------------------------------------------------------------------
$rawBody = file_get_contents('php://input');
$payload = json_decode((string) $rawBody, true);
if (!is_array($payload)) {
    mcp_fail(null, -32700, 'Parse error', 400);
}
if (array_is_list($payload)) {
    // Les batchs JSON-RPC ne sont pas supportés par ce transport minimal.
    mcp_fail(null, -32600, 'Invalid Request: batch requests are not supported', 400);
}

// ---------------------------------------------------------------------------
// 5. Dispatch JSON-RPC. Toute exception imprévue -> -32603 générique
//    (le détail part dans error_log, jamais chez le client).
// ---------------------------------------------------------------------------
try {
    $server = new McpServer($config);
    $response = $server->handle($payload);
} catch (Throwable $e) {
    error_log('[mcp] internal error: ' . $e->getMessage() . "\n" . $e->getTraceAsString());
    $id = array_key_exists('id', $payload) ? $payload['id'] : null;
    mcp_fail($id, -32603, 'Internal error', 200);
}

if ($response === null) {
    // Notification JSON-RPC : acquittée sans corps.
    http_response_code(202);
    exit;
}

http_response_code(200);
echo json_encode($response, JSON_UNESCAPED_UNICODE);
