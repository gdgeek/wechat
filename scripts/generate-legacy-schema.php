<?php
/**
 * Offline build utility, never loaded by the TypeScript service.
 * Usage: php scripts/generate-legacy-schema.php /path/to/frozen/api/migrations
 * Executes only trusted migration source against an in-memory DDL recorder.
 * No Yii installation, database connection, or production credentials are used.
 */
namespace yii\db {
    final class DdlSchema {
        public function getRawTableName(string $name): string { return Migration::name($name); }
        public function getTableSchema(string $name, bool $refresh = false): ?object {
            $name = Migration::name($name);
            if (!isset(Migration::$tables[$name])) return null;
            $columns = [];
            foreach (Migration::$tables[$name]['columns'] as $column => $definition) {
                $type = preg_split('/\s+(?:NOT\s+NULL|NULL|DEFAULT|UNIQUE|PRIMARY|COMMENT|AUTO_INCREMENT)\b/i', $definition, 2)[0];
                $columns[$column] = (object)['dbType' => $type, 'allowNull' => stripos($definition, 'NOT NULL') === false];
            }
            return (object)['fullName' => $name, 'columns' => $columns];
        }
        public function getTableForeignKeys(string $name, bool $refresh = false): array {
            $keys = [];
            foreach (Migration::$tables[Migration::name($name)]['foreign'] ?? [] as $key => $foreign) {
                $keys[] = (object)['name' => $key, 'columnNames' => $foreign['columns'], 'foreignTableName' => $foreign['table'], 'foreignColumnNames' => $foreign['references'], 'onDelete' => $foreign['delete'] ?? 'RESTRICT', 'onUpdate' => $foreign['update'] ?? 'RESTRICT'];
            }
            return $keys;
        }
        public function refreshTableSchema(string $name): void {}
    }
    final class DdlConnection {
        public string $driverName = 'mysql';
        public DdlSchema $schema;
        public function __construct() { $this->schema = new DdlSchema(); }
        public function quoteColumnName(string $name): string { return Migration::quoted($name); }
        public function quoteTableName(string $name): string { return Migration::quoted($name); }
    }
    final class ColumnBuilder {
        private array $suffix = [];
        public function __construct(private string $type) {}
        public function notNull(): self { $this->suffix['null'] = 'NOT NULL'; return $this; }
        public function null(): self { $this->suffix['null'] = 'NULL'; return $this; }
        public function comment(string $value): self { $this->suffix['comment'] = "COMMENT '" . str_replace("'", "''", $value) . "'"; return $this; }
        public function unique(): self { $this->suffix['unique'] = 'UNIQUE'; return $this; }
        public function defaultValue($value): self {
            $this->suffix['default'] = 'DEFAULT ' . (is_bool($value) ? (int)$value : (is_int($value) || is_float($value) ? $value : ($value === null ? 'NULL' : "'" . str_replace("'", "''", $value) . "'")));
            return $this;
        }
        public function defaultExpression(string $value): self { $this->suffix['default'] = 'DEFAULT ' . $value; return $this; }
        public function __toString(): string { return $this->type . ($this->suffix ? ' ' . implode(' ', $this->suffix) : ''); }
    }
    class Migration {
        public object $db;
        public static array $tables = [];
        public function __construct() { $this->db = new DdlConnection(); }
        public function up() {
            if (!method_exists($this, 'safeUp')) throw new \RuntimeException('No migration entry point: ' . static::class);
            return $this->safeUp();
        }
        public static function name(string $value): string { return str_replace(['{{%', '{{', '}}', '[[', ']]'], ['', '', '', '`', '`'], $value); }
        public static function quoted(string $value): string { return '`' . str_replace('`', '``', self::name($value)) . '`'; }
        public static function columnList($columns): array { return is_array($columns) ? $columns : array_map('trim', explode(',', $columns)); }
        public function primaryKey(): ColumnBuilder { return new ColumnBuilder('int NOT NULL AUTO_INCREMENT PRIMARY KEY'); }
        public function integer(): ColumnBuilder { return new ColumnBuilder('int'); }
        public function float(): ColumnBuilder { return new ColumnBuilder('float'); }
        public function boolean(): ColumnBuilder { return new ColumnBuilder('tinyint(1)'); }
        public function json(): ColumnBuilder { return new ColumnBuilder('json'); }
        public function date(): ColumnBuilder { return new ColumnBuilder('date'); }
        public function dateTime(): ColumnBuilder { return new ColumnBuilder('datetime'); }
        public function string(int $length = 255): ColumnBuilder { return new ColumnBuilder('varchar(' . $length . ')'); }
        public function char(int $length): ColumnBuilder { return new ColumnBuilder('char(' . $length . ')'); }
        public function createTable(string $name, array $columns, ?string $options = null): void {
            $name = self::name($name);
            if (isset(self::$tables[$name])) throw new \RuntimeException('Duplicate table ' . $name);
            self::$tables[$name] = ['columns' => [], 'constraints' => [], 'indexes' => [], 'foreign' => [], 'options' => $options ?? 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'];
            foreach ($columns as $column => $type) {
                if (is_int($column)) self::$tables[$name]['constraints'][] = self::name((string)$type);
                else self::$tables[$name]['columns'][$column] = (string)$type;
            }
        }
        public function addColumn(string $table, string $column, $type): void {
            $table = self::name($table);
            if (!isset(self::$tables[$table])) throw new \RuntimeException('Unknown table ' . $table);
            if (isset(self::$tables[$table]['columns'][$column])) throw new \RuntimeException('Duplicate column ' . $table . '.' . $column);
            self::$tables[$table]['columns'][$column] = (string)$type;
        }
        public function dropColumn(string $table, string $column): void {
            $table = self::name($table);
            if (!isset(self::$tables[$table]['columns'][$column])) throw new \RuntimeException('Unknown column ' . $table . '.' . $column);
            unset(self::$tables[$table]['columns'][$column]);
            foreach (self::$tables[$table]['indexes'] as $name => $index) if (in_array($column, $index['columns'], true)) unset(self::$tables[$table]['indexes'][$name]);
        }
        public function dropTable(string $table): void { unset(self::$tables[self::name($table)]); }
        public function createIndex(string $name, string $table, $columns, bool $unique = false): void {
            self::$tables[self::name($table)]['indexes'][self::name($name)] = ['columns' => self::columnList($columns), 'unique' => $unique];
        }
        public function dropIndex(string $name, string $table): void { unset(self::$tables[self::name($table)]['indexes'][self::name($name)]); }
        public function addForeignKey(string $name, string $table, $columns, string $refTable, $refColumns, ?string $delete = null, ?string $update = null): void {
            self::$tables[self::name($table)]['foreign'][self::name($name)] = ['columns' => self::columnList($columns), 'table' => self::name($refTable), 'references' => self::columnList($refColumns), 'delete' => $delete, 'update' => $update];
        }
        public function dropForeignKey(string $name, string $table): void { unset(self::$tables[self::name($table)]['foreign'][self::name($name)]); }
        public function execute(string $sql): void {
            if (preg_match('/^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` (.+)$/i', trim($sql), $match)) { $this->addColumn($match[1], $match[2], $match[3]); return; }
            if (preg_match('/^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$/i', trim($sql), $match)) { $this->dropColumn($match[1], $match[2]); return; }
            if (preg_match('/^ALTER TABLE `([^`]+)` DROP FOREIGN KEY `([^`]+)`, MODIFY COLUMN `([^`]+)` (.+?) NULL, ADD CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)` \(`([^`]+)`\) ON DELETE SET NULL ON UPDATE (CASCADE|RESTRICT|NO ACTION|SET NULL|SET DEFAULT)$/i', trim($sql), $match)) {
                if ($match[2] === $match[5] || $match[3] !== $match[6] || !isset(self::$tables[$match[1]]['columns'][$match[3]], self::$tables[$match[1]]['foreign'][$match[2]]) || isset(self::$tables[$match[1]]['foreign'][$match[5]])) throw new \RuntimeException('Invalid atomic record foreign key change.');
                self::$tables[$match[1]]['columns'][$match[3]] = $match[4] . ' NULL';
                $this->dropForeignKey($match[2], $match[1]);
                $this->addForeignKey($match[5], $match[1], $match[6], $match[7], $match[8], 'SET NULL', strtoupper($match[9]));
                return;
            }
            throw new \RuntimeException('Unsupported raw DDL: ' . $sql);
        }
    }
}
namespace {
    use yii\db\Migration;
    $directory = $argv[1] ?? null;
    if (!$directory || !is_dir($directory)) { fwrite(STDERR, "Usage: php scripts/generate-legacy-schema.php /path/to/frozen/api/migrations\n"); exit(1); }
    $files = glob(rtrim($directory, '/') . '/m*.php'); sort($files, SORT_STRING);
    if (!$files) { fwrite(STDERR, "No migrations found.\n"); exit(1); }
    foreach ($files as $file) {
        require $file;
        $class = pathinfo($file, PATHINFO_FILENAME);
        $migration = new $class();
        $migration->up();
    }
    $out = "-- Generated by scripts/generate-legacy-schema.php from the frozen Yii2 migration baseline.\n";
    $out .= '-- ' . count($files) . " ordered migrations; final up state only. No seed data or PHP runtime required.\n";
    $out .= "-- Preserve this file as a faithful baseline. Additional compatibility DDL is kept separately.\n\n";
    foreach (Migration::$tables as $name => $table) {
        $lines = [];
        foreach ($table['columns'] as $column => $type) $lines[] = '  ' . Migration::quoted($column) . ' ' . $type;
        foreach ($table['constraints'] as $constraint) $lines[] = '  ' . $constraint;
        foreach ($table['indexes'] as $indexName => $index) {
            foreach ($index['columns'] as $column) if (!isset($table['columns'][$column])) throw new RuntimeException('Invalid index ' . $indexName);
            $lines[] = '  ' . ($index['unique'] ? 'UNIQUE ' : '') . 'KEY ' . Migration::quoted($indexName) . ' (' . implode(', ', array_map([Migration::class, 'quoted'], $index['columns'])) . ')';
        }
        $out .= 'CREATE TABLE IF NOT EXISTS ' . Migration::quoted($name) . " (\n" . implode(",\n", $lines) . "\n) " . $table['options'] . ";\n\n";
    }
    // Adding references after all CREATE statements preserves cross-table order.
    foreach (Migration::$tables as $name => $table) foreach ($table['foreign'] as $foreignName => $foreign) {
        foreach ($foreign['columns'] as $column) if (!isset($table['columns'][$column])) throw new RuntimeException('Invalid foreign key ' . $foreignName);
        foreach ($foreign['references'] as $column) if (!isset(Migration::$tables[$foreign['table']]['columns'][$column])) throw new RuntimeException('Invalid foreign reference ' . $foreignName);
        $out .= 'ALTER TABLE ' . Migration::quoted($name) . ' ADD CONSTRAINT ' . Migration::quoted($foreignName) . ' FOREIGN KEY (' . implode(', ', array_map([Migration::class, 'quoted'], $foreign['columns'])) . ') REFERENCES ' . Migration::quoted($foreign['table']) . ' (' . implode(', ', array_map([Migration::class, 'quoted'], $foreign['references'])) . ')';
        if ($foreign['delete']) $out .= ' ON DELETE ' . $foreign['delete'];
        if ($foreign['update']) $out .= ' ON UPDATE ' . $foreign['update'];
        $out .= ";\n";
    }
    echo $out;
}
