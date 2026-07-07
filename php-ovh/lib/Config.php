<?php
/**
 * Chargement et validation de la configuration.
 *
 * Lit config.local.php (copie remplie de config.sample.php), applique les
 * surcharges par variables d'environnement, les défauts croisés
 * (smtp.user/password <- imap ; mail_from <- imap.user) puis valide.
 */

declare(strict_types=1);

final class Config
{
    private static ?array $cached = null;

    /** Charge (et met en cache) la configuration depuis le dossier racine du projet. */
    public static function get(): array
    {
        if (self::$cached === null) {
            self::$cached = self::load(dirname(__DIR__));
        }
        return self::$cached;
    }

    public static function load(string $baseDir): array
    {
        $file = $baseDir . DIRECTORY_SEPARATOR . 'config.local.php';
        if (!is_file($file)) {
            throw new RuntimeException(
                'Fichier de configuration introuvable : copiez config.sample.php en config.local.php et remplissez-le.'
            );
        }

        $cfg = require $file;
        if (!is_array($cfg)) {
            throw new RuntimeException('config.local.php doit retourner un tableau PHP (return [ ... ];).');
        }

        $defaults = [
            'mcp_auth_token' => '',
            'imap' => [
                'host' => '',
                'port' => 993,
                'user' => '',
                'password' => '',
                'encryption' => 'ssl',
            ],
            'smtp' => [
                'host' => '',
                'port' => 465,
                'user' => '',
                'password' => '',
                'encryption' => 'ssl',
            ],
            'mail_from' => '',
            'mail_from_name' => '',
        ];
        $cfg = array_replace_recursive($defaults, $cfg);

        // --- Surcharges par variables d'environnement -----------------------
        $env = static function (string $name): ?string {
            $v = getenv($name);
            return ($v === false || $v === '') ? null : $v;
        };

        if (($v = $env('MCP_AUTH_TOKEN')) !== null) {
            $cfg['mcp_auth_token'] = $v;
        }
        foreach ([['IMAP', 'imap'], ['SMTP', 'smtp']] as [$prefix, $key]) {
            if (($v = $env($prefix . '_HOST')) !== null) {
                $cfg[$key]['host'] = $v;
            }
            if (($v = $env($prefix . '_PORT')) !== null) {
                $cfg[$key]['port'] = (int) $v;
            }
            if (($v = $env($prefix . '_USER')) !== null) {
                $cfg[$key]['user'] = $v;
            }
            if (($v = $env($prefix . '_PASSWORD')) !== null) {
                $cfg[$key]['password'] = $v;
            }
            if (($v = $env($prefix . '_ENCRYPTION')) !== null) {
                $cfg[$key]['encryption'] = $v;
            }
        }
        if (($v = $env('MAIL_FROM')) !== null) {
            $cfg['mail_from'] = $v;
        }
        if (($v = $env('MAIL_FROM_NAME')) !== null) {
            $cfg['mail_from_name'] = $v;
        }

        // --- Normalisation ---------------------------------------------------
        $cfg['mcp_auth_token'] = (string) $cfg['mcp_auth_token'];
        $cfg['mail_from'] = (string) $cfg['mail_from'];
        $cfg['mail_from_name'] = (string) $cfg['mail_from_name'];
        foreach (['imap', 'smtp'] as $key) {
            $cfg[$key]['host'] = trim((string) $cfg[$key]['host']);
            $cfg[$key]['port'] = (int) $cfg[$key]['port'];
            $cfg[$key]['user'] = (string) $cfg[$key]['user'];
            $cfg[$key]['password'] = (string) $cfg[$key]['password'];
            $cfg[$key]['encryption'] = strtolower(trim((string) $cfg[$key]['encryption']));
        }

        // --- Défauts croisés ---------------------------------------------------
        if ($cfg['smtp']['user'] === '') {
            $cfg['smtp']['user'] = $cfg['imap']['user'];
        }
        if ($cfg['smtp']['password'] === '') {
            $cfg['smtp']['password'] = $cfg['imap']['password'];
        }
        if ($cfg['mail_from'] === '') {
            $cfg['mail_from'] = $cfg['imap']['user'];
        }

        // --- Validation ---------------------------------------------------------
        if (strlen($cfg['mcp_auth_token']) < 32) {
            throw new RuntimeException(
                "Configuration invalide : 'mcp_auth_token' doit faire au moins 32 caractères (générez-le avec : openssl rand -hex 32)."
            );
        }
        if ($cfg['imap']['host'] === '') {
            throw new RuntimeException("Configuration invalide : 'imap.host' est requis.");
        }
        if ($cfg['imap']['user'] === '') {
            throw new RuntimeException("Configuration invalide : 'imap.user' est requis.");
        }
        if ($cfg['imap']['password'] === '') {
            throw new RuntimeException("Configuration invalide : 'imap.password' est requis.");
        }
        if ($cfg['smtp']['host'] === '') {
            throw new RuntimeException("Configuration invalide : 'smtp.host' est requis.");
        }
        $allowed = ['ssl', 'starttls', 'none'];
        foreach (['imap', 'smtp'] as $key) {
            if (!in_array($cfg[$key]['encryption'], $allowed, true)) {
                throw new RuntimeException(
                    "Configuration invalide : '$key.encryption' doit valoir 'ssl', 'starttls' ou 'none' (reçu : '{$cfg[$key]['encryption']}')."
                );
            }
            if ($cfg[$key]['port'] < 1 || $cfg[$key]['port'] > 65535) {
                throw new RuntimeException("Configuration invalide : '$key.port' doit être un port valide (1-65535).");
            }
        }

        return $cfg;
    }
}
