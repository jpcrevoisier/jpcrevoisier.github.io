<?php
// ---------------------------------------------------------------
// https://jpcrevoisier.pages-perso.free.fr/webrtc/
// Serveur d'offres WebRTC
//   POST : enregistre une offre
//   GET  : renvoie la liste des offres encore valides
// Les offres périmées sont supprimées à chaque appel.
// Stockage : offres.php (tableau PHP exporté avec var_export)
// ---------------------------------------------------------------

// --- Configuration ---
const DATA_FILE    = __DIR__ . '/offres.php';  // fichier de stockage (PHP)
const LOCK_FILE    = __DIR__ . '/offres.lock'; // fichier de verrou
const DEFAULT_TTL  = 300;                      // durée de vie par défaut (secondes)
const MAX_TTL      = 3600;                     // durée de vie maximale autorisée
const MAX_SIZE     = 65536;                    // taille max d'une offre (octets)
const MAX_OFFERS   = 200;                      // nombre max d'offres stockées

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Réponse JSON + arrêt du script
function respond(int $code, array $data): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Pré-requête CORS
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST, OPTIONS');
    respond(405, ['error' => 'Méthode non autorisée.']);
}

// --- Lecture de l'entrée POST (avant de prendre le verrou) ---
$newOffer = null;
$ttl      = DEFAULT_TTL;

if ($method === 'POST') {
    $raw = file_get_contents('php://input', false, null, 0, MAX_SIZE + 1);

    if ($raw === false || trim($raw) === '') {
        respond(400, ['error' => 'Corps de requête vide.']);
    }
    if (strlen($raw) > MAX_SIZE) {
        respond(413, ['error' => 'Offre trop volumineuse.']);
    }

    // Accepte {"offer": "...", "ttl": 120} ou directement le texte de l'offre
    $json = json_decode($raw, true);
    if (is_array($json) && isset($json['offer'])) {
        $newOffer = $json['offer'];
        if (isset($json['ttl'])) {
            $ttl = (int) $json['ttl'];
        }
    } else {
        $newOffer = trim($raw);
    }

    if (!is_string($newOffer) || $newOffer === '') {
        respond(400, ['error' => 'Offre invalide.']);
    }

    // Durée de vie bornée
    $ttl = max(10, min($ttl, MAX_TTL));
}

// --- Verrou exclusif (include ne gère pas la concurrence) ---
$lock = fopen(LOCK_FILE, 'c');
if (!$lock || !flock($lock, LOCK_EX)) {
    respond(500, ['error' => 'Impossible de verrouiller le stockage.']);
}

// --- Lecture des offres existantes ---
clearstatcache(true, DATA_FILE);
$offres = @include(DATA_FILE);
if (!is_array($offres)) {
    $offres = [];
}

// --- Suppression des offres périmées ---
$now    = time();
$offres = array_values(array_filter($offres, function ($o) use ($now) {
    return isset($o['expires']) && $o['expires'] > $now;
}));

// --- POST : ajout de la nouvelle offre ---
$created = null;
if ($method === 'POST') {
    if (count($offres) >= MAX_OFFERS) {
        flock($lock, LOCK_UN);
        fclose($lock);
        respond(503, ['error' => 'Trop d\'offres en attente, réessaie plus tard.']);
    }

    $created = [
        'id'      => bin2hex(random_bytes(8)),
        'offer'   => $newOffer,
        'created' => $now,
        'expires' => $now + $ttl,
    ];
    $offres[] = $created;
}

// --- Réécriture du fichier (purge + éventuel ajout) ---
// Écriture atomique : fichier temporaire puis rename
$tmp = DATA_FILE . '.tmp';
$ok  = file_put_contents($tmp, "<?php\nreturn " . var_export($offres, true) . ";\n", LOCK_EX) !== false
    && rename($tmp, DATA_FILE);

// Invalide le cache opcache pour que le prochain include relise le fichier
if ($ok && function_exists('opcache_invalidate')) {
    opcache_invalidate(DATA_FILE, true);
}

flock($lock, LOCK_UN);
fclose($lock);

if (!$ok) {
    @unlink($tmp);
    respond(500, ['error' => 'Écriture du stockage impossible.']);
}

// --- Réponse ---
if ($method === 'POST') {
    respond(201, [
        'id'      => $created['id'],
        'expires' => $created['expires'],
        'ttl'     => $ttl,
    ]);
}

respond(200, [
    'now'    => $now,
    'count'  => count($offres),
    'offers' => $offres,
]);