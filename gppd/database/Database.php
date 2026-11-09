<?php

class Database
{
    private PDO $pdo;

    public function __construct(array $config)
    {
        $db = $config['database'];

        if ($db['driver'] === 'sqlite') {
            $dir = dirname($db['sqlite_path']);

            if (!is_dir($dir)) {
                mkdir($dir, 0750, true);
            }

            $this->pdo = new PDO('sqlite:' . $db['sqlite_path']);
            $this->pdo->exec('PRAGMA foreign_keys = ON');
            $this->pdo->exec('PRAGMA journal_mode = WAL');

        } elseif ($db['driver'] === 'mysql') {
            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                $db['mysql_host'],
                $db['mysql_port'],
                $db['mysql_name']
            );

            $this->pdo = new PDO(
                $dsn,
                $db['mysql_user'],
                $db['mysql_password']
            );

        } else {
            throw new RuntimeException('Database driver inconnu');
        }

        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

        $this->initialize();
    }

    private function initialize(): void
    {
        $this->pdo->exec("
            CREATE TABLE IF NOT EXISTS files (
                id VARCHAR(36) PRIMARY KEY,
                parent_id VARCHAR(36) NULL,
                name VARCHAR(255) NOT NULL,
                storage_name VARCHAR(255) NULL,
                mime_type VARCHAR(255) NULL,
                size BIGINT NOT NULL DEFAULT 0,
                is_directory INTEGER NOT NULL DEFAULT 0,
                owner VARCHAR(100) NOT NULL,
                created_at VARCHAR(30) NOT NULL,
                updated_at VARCHAR(30) NOT NULL
            )
        ");

        $this->pdo->exec("
            CREATE TABLE IF NOT EXISTS permissions (
                id INTEGER PRIMARY KEY " .
                ($this->driver() === 'mysql' ? 'AUTO_INCREMENT' : 'AUTOINCREMENT') . ",
                resource_id VARCHAR(36) NOT NULL,
                principal VARCHAR(100) NOT NULL,
                can_read INTEGER NOT NULL DEFAULT 0,
                can_write INTEGER NOT NULL DEFAULT 0,
                can_delete INTEGER NOT NULL DEFAULT 0,
                UNIQUE(resource_id, principal)
            )
        ");

        $this->pdo->exec("
            CREATE INDEX IF NOT EXISTS idx_files_parent
            ON files(parent_id)
        ");

        $this->pdo->exec("
            CREATE INDEX IF NOT EXISTS idx_permissions_resource
            ON permissions(resource_id)
        ");
    }

    private function driver(): string
    {
        return $this->pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    public function query(string $sql, array $params = []): PDOStatement
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }

    public function one(string $sql, array $params = []): ?array
    {
        return $this->query($sql, $params)->fetch() ?: null;
    }

    public function all(string $sql, array $params = []): array
    {
        return $this->query($sql, $params)->fetchAll();
    }
}
