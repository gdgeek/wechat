<?php
/** Invoked by verify-yii-admin-interop.cjs with temporary test keys over stdin. */
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$target = $input['redis'] ?? [];
if (($input['test'] ?? null) !== true || !in_array($target['host'] ?? null, ['127.0.0.1', 'localhost'], true)
    || !is_int($target['port'] ?? null) || $target['port'] <= 1024 || $target['port'] > 65535 || $target['port'] === 6379
    || ($target['database'] ?? null) !== 15) {
    fwrite(STDERR, 'Only an explicitly selected isolated localhost Redis test port and DB 15 are allowed.');
    exit(2);
}
$root = realpath($input['sourceRoot'] ?? '');
$api = $root && is_file($root . '/api/components/AdminTokenService.php') ? $root . '/api' : $root;
if (!$api || !is_file($api . '/components/AdminTokenService.php') || !is_file($api . '/vendor/autoload.php')) {
    fwrite(STDERR, 'YII_SOURCE_ROOT must contain the current Yii backend and installed Composer dependencies.');
    exit(2);
}
require $api . '/vendor/autoload.php';
require $api . '/vendor/yiisoft/yii2/Yii.php';
require $api . '/components/AdminTokenStore.php';
require $api . '/components/AdminTokenService.php';
$redis = new yii\redis\Connection(['hostname'=>$target['host'],'port'=>$target['port'],'database'=>15,
    'password'=>$target['password'] ?: null,'connectionTimeout'=>1.5,'dataTimeout'=>1.5,'retries'=>0]);
$jwt = ['class'=>bizley\jwt\Jwt::class,'signer'=>bizley\jwt\Jwt::ES256,
    'signingKey'=>['key'=>$input['private'],'method'=>bizley\jwt\Jwt::METHOD_PLAIN],
    'verifyingKey'=>['key'=>$input['public'],'method'=>bizley\jwt\Jwt::METHOD_PLAIN]];
$app = new yii\web\Application(['id'=>'isolated-node-php-interop','basePath'=>$api,
    'components'=>['request'=>['cookieValidationKey'=>'isolated-test'],'adminJwt'=>$jwt]]);
$tokens = new app\components\AdminTokenService(['store'=>new app\components\AdminTokenStore(['redis'=>$redis]),'issuer'=>$input['issuer']]);
try {
    if ($input['action']==='issue') { $output=['token'=>$tokens->issue($input['identity'])]; }
    else {
        $app->request->headers->set('Authorization','Bearer '.$input['access']);
        $output=['identity'=>$tokens->identityFromRequest()];
        if ($input['action']==='refresh') { $output['next']=$tokens->refresh($input['refresh']); }
        if ($input['action']==='revoke') { $tokens->revoke($input['refresh']); $output['revoked']=true; }
    }
    echo json_encode($output,JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    fwrite(STDERR, 'Yii administrator interoperability operation failed (' . get_class($error) . ').');
    exit(1);
} finally { $redis->close(); $app->errorHandler->unregister(); }
