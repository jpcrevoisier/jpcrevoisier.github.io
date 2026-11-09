<?php

class Api
{
    private Database $db;
    private Storage $storage;
    private Auth $auth;
    private array $config;

    public function __construct(array $config)
    {
        $this->config = $config;
        $this->db = new Database($config);
        $this->storage = new Storage($config['storage_path']);
        $this->auth = new Auth($config);
    }

    public function run(): never
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

        if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE'], true)) {
            header('Allow: GET, POST, PUT, DELETE');
            Response::error('Méthode non autorisée', 405);
        }

        $uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
        $path = preg_replace('#^/api/?#', '', $uri);
        $parts = array_values(array_filter(explode('/', trim($path, '/'))));

        try {
            if (($parts[0] ?? '') === 'files') {
                $this->files($method, $parts);
            }

            if (($parts[0] ?? '') === 'directories') {
                $this->directories($method, $parts);
            }

            Response::error('Endpoint introuvable', 404);

        } catch (Throwable $e) {
            if ($this->config['debug']) {
                Response::error($e->getMessage(), 500);
            }

            error_log((string)$e);
            Response::error('Erreur interne du serveur', 500);
        }
    }

    private function files(string $method, array $parts): never
    {
        $id = $parts[1] ?? null;
        $action = $parts[2] ?? null;

        if ($method === 'GET' && !$id) {
            $parent = $_GET['parent_id'] ?? null;
            $this->checkParent($parent, 'read');

            $items = $this->db->all(
                'SELECT id,parent_id,name,mime_type,size,is_directory,owner,created_at,updated_at
                 FROM files WHERE ' .
                ($parent === null ? 'parent_id IS NULL' : 'parent_id = ?') .
                ' ORDER BY is_directory DESC, name ASC',
                $parent === null ? [] : [$parent]
            );

            $items = array_values(array_filter(
                $items,
                fn($item) => $this->allowed($item, 'read')
            ));

            Response::success($items);
        }

        $file = $this->getResource($id);

        if ($method === 'GET' && $action === null) {
            $this->requirePermission($file, 'read');
            unset($file['storage_name']);
            Response::success($file);
        }

        if ($method === 'GET' && in_array($action, ['download', 'preview'], true)) {
            $this->requirePermission($file, 'read');

            if ($file['is_directory']) {
                Response::error('Ce n\'est pas un fichier', 400);
            }

            Response::file(
                $this->storage->path($file['id']),
                $file['name'],
                $file['mime_type'] ?: 'application/octet-stream',
                $action === 'preview'
            );
        }

        if ($method === 'POST' && !$id) {
            $parent = $_POST['parent_id'] ?? null;
            $this->checkParent($parent, 'write');

            if (!isset($_FILES['file'])) {
                Response::error('Aucun fichier reçu');
            }

            $upload = $_FILES['file'];

            if ($upload['size'] > $this->config['max_upload_size']) {
                Response::error('Fichier trop volumineux', 413);
            }

            $finfo = new finfo(FILEINFO_MIME_TYPE);
            $mime = $finfo->file($upload['tmp_name']) ?: 'application/octet-stream';

            $allowed = $this->config['allowed_mime_types'];

            if ($allowed && !in_array($mime, $allowed, true)) {
                Response::error('Type de fichier interdit', 415);
            }

            $saved = $this->storage->save($upload);
            $name = basename(str_replace('\\', '/', $upload['name']));

            $this->db->query(
                'INSERT INTO files
                (id,parent_id,name,storage_name,mime_type,size,is_directory,owner,created_at,updated_at)
                VALUES (?,?,?,?,?,?,0,?,?,?)',
                [
                    $saved['id'],
                    $parent,
                    $name,
                    $saved['id'],
                    $mime,
                    $upload['size'],
                    $this->auth->user(),
                    date(DATE_ATOM),
                    date(DATE_ATOM)
                ]
            );

            Response::success([
                'id' => $saved['id'],
                'name' => $name,
                'size' => $upload['size'],
                'mime_type' => $mime
            ], 201);
        }

        if ($method === 'PUT' && $id && !$action) {
            $this->requirePermission($file, 'write');
            $data = $this->input();

            $name = $data['name'] ?? $file['name'];
            $parent = $data['parent_id'] ?? $file['parent_id'];

            $this->validateName($name);
            $this->checkParent($parent, 'write');

            if ($parent === $id) {
                Response::error('Déplacement circulaire interdit');
            }

            $this->db->query(
                'UPDATE files SET name=?,parent_id=?,updated_at=? WHERE id=?',
                [$name, $parent, date(DATE_ATOM), $id]
            );

            Response::success(['id' => $id, 'name' => $name, 'parent_id' => $parent]);
        }

        if ($method === 'PUT' && $id && $action === 'permissions') {
            if (!$this->auth->isAdmin() && $file['owner'] !== $this->auth->user()) {
                Response::error('Permission refusée', 403);
            }

            $data = $this->input();
            $principal = $data['principal'] ?? '';
            $this->validateName($principal);

            $this->db->query(
                'INSERT INTO permissions
                (resource_id,principal,can_read,can_write,can_delete)
                VALUES (?,?,?,?,?)
                ON CONFLICT(resource_id,principal) DO UPDATE SET
                can_read=excluded.can_read,
                can_write=excluded.can_write,
                can_delete=excluded.can_delete',
                [
                    $id,
                    $principal,
                    (int)($data['can_read'] ?? 0),
                    (int)($data['can_write'] ?? 0),
                    (int)($data['can_delete'] ?? 0)
                ]
            );

            Response::success(['principal' => $principal]);
        }

        if ($method === 'DELETE' && $id) {
            $this->requirePermission($file, 'delete');
            $this->deleteResource($file);
            Response::success(null);
        }

        Response::error('Opération non supportée', 405);
    }

    private function directories(string $method, array $parts): never
    {
        $id = $parts[1] ?? null;

        if ($method === 'POST' && !$id) {
            $data = $this->input();
            $name = $data['name'] ?? '';
            $parent = $data['parent_id'] ?? null;

            $this->validateName($name);
            $this->checkParent($parent, 'write');

            $id = Storage::uuid();
            $now = date(DATE_ATOM);

            $this->db->query(
                'INSERT INTO files
                (id,parent_id,name,storage_name,mime_type,size,is_directory,owner,created_at,updated_at)
                VALUES (?,?,?,NULL,NULL,0,1,?,?,?)',
                [$id, $parent, $name, $this->auth->user(), $now, $now]
            );

            Response::success(['id' => $id, 'name' => $name], 201);
        }

        if ($id) {
            $dir = $this->getResource($id);

            if (!$dir['is_directory']) {
                Response::error('Ce n\'est pas un dossier', 400);
            }

            if ($method === 'DELETE') {
                $this->requirePermission($dir, 'delete');
                $this->deleteResource($dir);
                Response::success(null);
            }

            if ($method === 'PUT') {
                $this->requirePermission($dir, 'write');
                $data = $this->input();
                $name = $data['name'] ?? $dir['name'];
                $parent = $data['parent_id'] ?? $dir['parent_id'];

                $this->validateName($name);
                $this->checkParent($parent, 'write');

                if ($parent === $id || $this->isDescendant($parent, $id)) {
                    Response::error('Déplacement circulaire interdit');
                }

                $this->db->query(
                    'UPDATE files SET name=?,parent_id=?,updated_at=? WHERE id=?',
                    [$name, $parent, date(DATE_ATOM), $id]
                );

                Response::success(['id' => $id, 'name' => $name]);
            }
        }

        Response::error('Opération non supportée', 405);
    }

    private function input(): array
    {
        $data = json_decode(file_get_contents('php://input'), true);

        if (!is_array($data)) {
            Response::error('JSON invalide');
        }

        return $data;
    }

    private function getResource(?string $id): array
    {
        if (!$id) {
            Response::error('Identifiant manquant');
        }

        $file = $this->db->one('SELECT * FROM files WHERE id=?', [$id]);

        if (!$file) {
            Response::error('Ressource introuvable', 404);
        }

        return $file;
    }

    private function validateName(string $name): void
    {
        if (
            $name === '' ||
            strlen($name) > 255 ||
            $name === '.' ||
            $name === '..' ||
            str_contains($name, '/') ||
            str_contains($name, '\\') ||
            preg_match('/[\x00-\x1F]/', $name)
        ) {
            Response::error('Nom invalide');
        }
    }

    private function checkParent(?string $parent, string $permission): void
    {
        if ($parent === null) {
            return;
        }

        $dir = $this->getResource($parent);

        if (!$dir['is_directory']) {
            Response::error('Dossier parent invalide');
        }

        $this->requirePermission($dir, $permission);
    }

    private function allowed(array $resource, string $permission): bool
    {
        if ($this->auth->isAdmin() || $resource['owner'] === $this->auth->user()) {
            return true;
        }

        $column = match ($permission) {
            'read' => 'can_read',
            'write' => 'can_write',
            'delete' => 'can_delete',
            default => 'can_read'
        };

        $acl = $this->db->one(
            "SELECT $column AS allowed FROM permissions
             WHERE resource_id=? AND principal=?",
            [$resource['id'], $this->auth->user()]
        );

        if ($acl && (int)$acl['allowed'] === 1) {
            return true;
        }

        // Héritage des permissions du dossier parent
        if ($resource['parent_id']) {
            $parent = $this->db->one(
                'SELECT * FROM files WHERE id=?',
                [$resource['parent_id']]
            );

            if ($parent) {
                return $this->allowed($parent, $permission);
            }
        }

        return false;
    }

    private function requirePermission(array $resource, string $permission): void
    {
        if (!$this->allowed($resource, $permission)) {
            Response::error('Permission refusée', 403);
        }
    }

    private function isDescendant(?string $parent, string $id): bool
    {
        while ($parent !== null) {
            if ($parent === $id) {
                return true;
            }

            $row = $this->db->one(
                'SELECT parent_id FROM files WHERE id=?',
                [$parent]
            );

            $parent = $row['parent_id'] ?? null;
        }

        return false;
    }

    private function deleteResource(array $resource): void
    {
        $children = $this->db->all(
            'SELECT * FROM files WHERE parent_id=?',
            [$resource['id']]
        );

        foreach ($children as $child) {
            $this->requirePermission($child, 'delete');
            $this->deleteResource($child);
        }

        if (!$resource['is_directory']) {
            $this->storage->delete($resource['id']);
        }

        $this->db->query(
            'DELETE FROM permissions WHERE resource_id=?',
            [$resource['id']]
        );

        $this->db->query(
            'DELETE FROM files WHERE id=?',
            [$resource['id']]
        );
    }
}
