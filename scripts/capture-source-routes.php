<?php
// Reflection of legacy source can emit PHP 8.4 deprecations; keep stdout JSON.
ini_set('display_errors', 'stderr');
$root = realpath($argv[1] ?? getenv('YII_SOURCE_ROOT') ?: '');
if (!$root || !is_file($root . '/api/vendor/autoload.php')) { fwrite(STDERR, "Usage: php capture-source-routes.php <Yii checkout with api/vendor>\n"); exit(1); }
require $root . '/api/vendor/autoload.php';
require $root . '/api/vendor/yiisoft/yii2/Yii.php';
Yii::setAlias('@app', $root . '/api');
spl_autoload_register(function ($class) use ($root) { if (str_starts_with($class, 'app\\')) { $path = $root . '/api/' . str_replace('\\', '/', substr($class, 4)) . '.php'; if (is_file($path)) require $path; } }, true, true);
class SnapshotWebRule extends yii\web\UrlRule {
  public $sourcePattern;
  public function init() { $this->sourcePattern = $this->pattern; parent::init(); }
}
$config = file_get_contents($root . '/files/api/config/web.php');
$offset = strpos($config, "'rules' => [");
$start = strpos($config, '[', $offset);
$tail = substr($config, $start);
$tokens = token_get_all('<?php ' . $tail);
$depth = 0; $length = 0;
foreach ($tokens as $index => $token) {
  if ($index === 0) continue;
  $raw = is_array($token) ? $token[1] : $token;
  if ($token === '[') $depth++;
  if ($token === ']') $depth--;
  $length += strlen($raw);
  if ($depth === 0) break;
}
$rules = eval('return ' . substr($tail, 0, $length) . ';');
$metadata = []; $webRules = [];
function lineOf($text, $needle) { $position = strpos($text, $needle); return $position === false ? null : substr_count(substr($text, 0, $position), "\n") + 1; }
foreach ($rules as $key => $value) {
  if (is_string($key)) {
    preg_match('/^(?:(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+)?(.*)$/', $key, $match);
    $rule = new SnapshotWebRule(['pattern' => $match[2], 'route' => $value, 'verb' => $match[1] ? [$match[1]] : []]);
    $webRules[] = [$rule, ['kind' => 'explicit', 'configLine' => lineOf($config, "'".str_replace("\\", "\\\\", $key)."'"), 'declaration' => $key]];
  } elseif (($value['class'] ?? null) === 'yii\\rest\\UrlRule') {
    $value['ruleConfig'] = ['class' => SnapshotWebRule::class];
    unset($value['class']);
    $rule = new yii\rest\UrlRule($value);
    $property = new ReflectionProperty(yii\web\CompositeUrlRule::class, 'rules');
    foreach ($property->getValue($rule) as $urlName => $expanded) foreach ($expanded as $child) {
      $controller = substr($child->route, 0, strrpos($child->route, '/'));
      $webRules[] = [$child, ['kind' => 'rest', 'configLine' => lineOf($config, "'".$controller."'"), 'declaration' => 'yii\\rest\\UrlRule ' . $controller]];
    }
  } else {
    $value['class'] = SnapshotWebRule::class;
    $rule = Yii::createObject($value);
    $webRules[] = [$rule, ['kind' => 'explicit-any-verb', 'configLine' => lineOf($config, "'pattern' => '".$value['pattern']."'"), 'declaration' => $value['pattern']]];
  }
}
$output = []; $seen = []; $sources = [];
foreach ($webRules as $index => [$rule, $metadata]) {
  $rawPattern = $rule->sourcePattern;
  $path = '/' . preg_replace_callback('/<([a-zA-Z_][\w]*)(?::([^>]*))?>/', fn($match) => '{'.$match[1].'}', $rawPattern);
  $parameters = [];
  preg_match_all('/<([a-zA-Z_][\w]*)(?::([^>]*))?>/', $rawPattern, $captures, PREG_SET_ORDER);
  foreach ($captures as $capture) $parameters[$capture[1]] = $capture[2] ?? '[^/]+';
  $sample = '/' . preg_replace_callback('/<([a-zA-Z_][\w]*)(?::([^>]*))?>/', fn($match) => str_contains($match[2] ?? '', '32') ? str_repeat('a', 32) : '1', $rawPattern);
  $routeParts = explode('/', $rule->route);
  $action = array_pop($routeParts); $controllerName = array_pop($routeParts);
  $className = yii\helpers\Inflector::id2camel($controllerName, '-') . 'Controller';
  $namespace = $routeParts ? 'app\\modules\\' . implode('\\', $routeParts) . '\\controllers' : 'app\\controllers';
  $class = $namespace . '\\' . $className;
  $controllerFile = ($routeParts ? 'api/modules/' . implode('/', $routeParts) : 'api') . '/controllers/' . $className . '.php';
  $sourceStatus = 'missing-controller'; $actionSource = null; $actionLine = null; $actionClass = null; $inherited = false;
  if (class_exists($class)) {
    $reflection = new ReflectionClass($class);
    $inline = 'action' . str_replace(' ', '', ucwords(str_replace('-', ' ', $action)));
    if ($reflection->hasMethod($inline) && $reflection->getMethod($inline)->isPublic()) {
      $method = $reflection->getMethod($inline);
      $sourceStatus = 'resolvable'; $actionSource = str_replace($root . '/', '', $method->getFileName()); $actionLine = $method->getStartLine(); $actionClass = $class . '::' . $method->getName();
    } else {
      $controller = $reflection->newInstanceWithoutConstructor();
      $external = $controller->actions();
      if (isset($external[$action])) {
        $sourceStatus = 'resolvable'; $actionClass = $external[$action]['class'] ?? $external[$action];
        $actionReflection = new ReflectionClass($actionClass);
        $actionSource = 'api/vendor/' . substr($actionReflection->getFileName(), strpos($actionReflection->getFileName(), '/vendor/') + 8); $actionLine = $actionReflection->getStartLine(); $inherited = true;
      } else $sourceStatus = 'missing-action';
    }
  }
  if (is_file($root . '/' . $controllerFile)) $sources[$controllerFile] = hash_file('sha256', $root . '/' . $controllerFile);
  foreach ($rule->verb ?: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'] as $verb) {
    $unique = $verb . ' ' . $path;
    if (isset($seen[$unique])) continue;
    $seen[$unique] = true;
    $output[] = ['method' => $verb, 'path' => $path, 'sample' => $sample, 'parameters' => (object) $parameters, 'yiiRoute' => $rule->route, 'action' => $action, 'controller' => $controllerFile, 'sourceStatus' => $sourceStatus, 'actionSource' => $actionSource, 'actionLine' => $actionLine, 'actionClass' => $actionClass, 'inheritedRestAction' => $inherited, 'sourceAnyVerbFallback' => empty($rule->verb), 'sourcePattern' => $rawPattern, 'sampleMatchesSource' => preg_match($rule->pattern, ltrim($sample, '/')) === 1, 'configLine' => $metadata['configLine'], 'declaration' => $metadata['declaration']];
  }
}
$sources['files/api/config/web.php'] = hash_file('sha256', $root . '/files/api/config/web.php');
ksort($sources);
usort($output, fn($a,$b) => strcmp($a['path'].' '.$a['method'], $b['path'].' '.$b['method']));
echo json_encode(['schemaVersion' => 1, 'sourceRoot' => $root, 'framework' => ['name' => 'yiisoft/yii2', 'version' => Yii::getVersion(), 'urlRuleSha256' => hash_file('sha256', $root . '/api/vendor/yiisoft/yii2/rest/UrlRule.php')], 'sourceFiles' => $sources, 'routes' => $output], JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE), PHP_EOL;
