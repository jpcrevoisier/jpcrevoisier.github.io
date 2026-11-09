<?php

class Storage
{
    private string $root;

    public function __construct(string $root)
    {
        $this->root = rtrim($root, DIRECTORY_SEPARATOR);

        if (!is_dir($this->root)) {
            mkdir($this->root, 0750, true);
        }

        $real = realpath($this->root);

        if ($real === false) {
            throw new RuntimeException('Stockage inaccessible');
        }

        $this->root = $real;
    }

    public static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        $hex = bin2hex($bytes);

        return sprintf(
            '%s-%s-%s-%s-%s',
            substr($hex, 0, 8),
            substr($hex, 8, 4),
            substr($hex, 12, 4),
            substr($hex, 16, 4),
            substr($hex, 20, 12)
        );
    }

    public function save(array $upload): array
    {
        if (($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new RuntimeException('Erreur lors de l\'upload');
        }

        if (!is_uploaded_file($upload['tmp_name'])) {
            throw new RuntimeException('Upload invalide');
        }

        $id = self::uuid();
        $directory = $this->root . '/' . substr($id, 0, 2);

        if (!is_dir($directory)) {
            mkdir($directory, 0750, true);
        }

        $path = $directory . '/' . $id;

        if (!move_uploaded_file($upload['tmp_name'], $path)) {
            throw new RuntimeException('Impossible de stocker le fichier');
        }

        chmod($path, 0640);

        return [
            'id' => $id,
            'path' => $path,
        ];
    }

    public function path(string $id): string
    {
        if (!preg_match('/^[a-f0-9-]{36}$/i', $id)) {
            throw new RuntimeException('Identifiant invalide');
        }

        return $this->root . '/' . substr($id, 0, 2) . '/' . $id;
    }

    public function delete(string $id): void
    {
        $path = $this->path($id);

        if (is_file($path)) {
            unlink($path);
        }
    }
}
