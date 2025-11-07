/**
 * @OnlyCurrentDoc
 */

// ★★★ 設定項目 ★★★
// JSONファイルが格納されているGoogleドライブのフォルダIDを設定してください
const JSON_FOLDER_ID = '1yvdscBjiTHvpUvXSYx6gw9oJzU8Tkfd2'; 

// [改善] キャッシュの有効期限（秒単位）を設定 (例: 3600秒 = 1時間)
// データの更新頻度に応じて調整してください。
const CACHE_EXPIRATION_SECONDS = 90000; // [変更] 3600秒 -> 90000秒 (25時間)

// [改善] キャッシュを識別するためのキー
const CACHE_KEY = 'projectsDataCache';
// ★★★ 設定項目ここまで ★★★


/**
 * WebアプリとしてGETリクエストを受け取ったときのメイン関数
 * @param {object} e - イベントオブジェクト
 * @return {GoogleAppsScript.Content.TextOutput} - JSON形式のレスポンス
 */
function doGet(e) {
  try {
    // 1. スクリプトキャッシュを取得
    const cache = CacheService.getScriptCache();
    
    // 2. キャッシュからデータを取得試行
    const cachedData = cache.get(CACHE_KEY);

    let jsonOutput;

    if (cachedData != null) {
      // 3a. キャッシュがあった場合 (Cache Hit)
      // Driveにアクセスせず、キャッシュから取得したJSON文字列をそのまま使用
      Logger.log('Cache Hit. Returning cached data.');
      jsonOutput = cachedData;

    } else {
      // 3b. キャッシュがなかった場合 (Cache Miss)
      Logger.log('Cache Miss. Fetching data from Drive.');
      
      // 4. Driveからプロジェクトデータを取得（従来処理）
      const projects = getProjectsData();
      
      // 5. 取得したデータをJSON文字列に変換
      jsonOutput = JSON.stringify(projects, null, 2);
      
      // 6. データをキャッシュに保存（次のリクエストのために）
      try {
        cache.put(CACHE_KEY, jsonOutput, CACHE_EXPIRATION_SECONDS);
        Logger.log(`Data stored in cache for ${CACHE_EXPIRATION_SECONDS} seconds.`);
      } catch (cacheErr) {
        // キャッシュの保存に失敗しても、レスポンスは返す（ログには残す）
        Logger.log('Failed to store data in cache: ' + cacheErr.message);
      }
    }
    
    // 7. JSONとして出力
    return ContentService.createTextOutput(jsonOutput)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    // エラーハンドリング
    Logger.log('Error in doGet: ' + err.message);
    Logger.log('Stack: ' + err.stack);
    
    const errorResponse = JSON.stringify([{ 
      error: 'GAS側でエラーが発生しました: ' + err.message,
      details: 'GASのログを確認してください。'
    }]);
    
    return ContentService.createTextOutput(errorResponse)
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 指定されたDriveフォルダからすべてのJSONファイルを読み込み、内容を配列として返す
 * (この関数はキャッシュがない場合のみ呼ばれる)
 * @return {Array<object>} - 各JSONファイルの内容をパースしたオブジェクトの配列
 */
function getProjectsData() {
  if (JSON_FOLDER_ID === 'YOUR_DRIVE_FOLDER_ID_HERE' || JSON_FOLDER_ID === '') {
    throw new Error('GASコード内の JSON_FOLDER_ID が設定されていません。');
  }
  
  const folder = DriveApp.getFolderById(JSON_FOLDER_ID);
  
  // フォルダ内の「すべて」のファイルを取得する
  const files = folder.getFiles(); 
  
  const projects = [];
  
  while (files.hasNext()) {
    const file = files.next();
    
    // ファイル名が .json で終わるものだけを対象にする
    if (file.getName().toLowerCase().endsWith('.json')) {
      try {
        const content = file.getBlob().getDataAsString('UTF-8');
        
        // 空のJSONファイルや不正なJSONを考慮
        if (content) {
          const json = JSON.parse(content);
          projects.push(json);
        } else {
          Logger.log(`Skipping empty JSON file: ${file.getName()}`);
        }
      } catch (e) {
        // 特定のJSONファイルが壊れている場合、ログに記録してスキップ
        Logger.log(`Failed to parse JSON file: ${file.getName()}. Error: ${e.message}`);
      }
    }
  }
  
  // 日付の降順（新しい順）でソートする
  try {
    projects.sort((a, b) => {
      // startTimeが存在し、有効な日付であることを確認
      const dateA = (a && a.startTime) ? new Date(a.startTime) : new Date(0);
      const dateB = (b && b.startTime) ? new Date(b.startTime) : new Date(0);
      
      // 無効な日付(Invalid Date)の場合、最古として扱う
      const timeA = isNaN(dateA.getTime()) ? 0 : dateA.getTime();
      const timeB = isNaN(dateB.getTime()) ? 0 : dateB.getTime();

      return timeB - timeA;
    });
  } catch(e) {
      Logger.log('Sorting error: ' + e.message);
      // ソートに失敗しても（ソートされていない）処理は続行
  }
  
  return projects;
}

/**
 * (手動実行用)
 * キャッシュを強制的にクリアするための関数
 * * 使い方:
 * 1. Google Drive上のJSONファイルを更新する
 * 2. GASのエディタ（管理画面）を開く
 * 3. 上部の関数選択で「clearCache」を選び、[実行]ボタンを押す
 * 4. これによりキャッシュが削除され、次回のWebアプリへのアクセスで最新情報が再取得されます
 */
function clearCache() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(CACHE_KEY);
    Logger.log(`Cache with key "${CACHE_KEY}" has been cleared.`);
    // ユーザーにフィードバック（エディタ上での実行なら）
    if (typeof Browser !== 'undefined') {
      Browser.msgBox('キャッシュをクリアしました');
    }
  } catch (e) {
    Logger.log('Error clearing cache: ' + e.message);
  }
}

/**
 * (トリガー実行用)
 * 1日1回など、指定した時間にキャッシュを強制的に更新するための関数
 * * 使い方:
 * 1. GASのエディタ（管理画面）を開く
 * 2. 左側の時計アイコン（トリガー）をクリック
 * 3. [トリガーを追加] ボタンを押す
 * 4. [実行する関数を選択] で「refreshCacheTrigger」を選ぶ
 * 5. [イベントのソースを選択] で「時間主導型」を選ぶ
 * 6. [時間ベースのトリガーのタイプを選択] で「日付ベースのタイマー」を選ぶ
 * 7. [時刻を選択] で、キャッシュを更新したい時間（例: 深夜3時〜4時）を選ぶ
 * 8. [保存] を押す
 */
function refreshCacheTrigger() {
  Logger.log('Trigger started: Refreshing cache...');
  try {
    // 1. Driveからプロジェクトデータを取得
    const projects = getProjectsData();
    
    // 2. 取得したデータをJSON文字列に変換
    const jsonOutput = JSON.stringify(projects, null, 2);
    
    // 3. データをキャッシュに保存（既存のキャッシュを上書き）
    const cache = CacheService.getScriptCache();
    cache.put(CACHE_KEY, jsonOutput, CACHE_EXPIRATION_SECONDS);
    
    Logger.log('Trigger success: Cache has been refreshed.');

  } catch (err) {
    // トリガー実行が失敗した場合、ログに詳細を記録
    Logger.log('Error in refreshCacheTrigger: ' + err.message);
    Logger.log('Stack: ' + err.stack);
  }
}