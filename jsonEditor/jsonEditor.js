/**
 * GAS JSON編集Webアプリ
 * Googleドライブの特定フォルダ内のJSONファイルを編集するWebアプリ
 */

// 設定: スクリプトプロパティに以下を設定してください
// ADMIN_PASSWORD: 管理者パスワード
// FOLDER_ID: JSONファイルが保存されているGoogleドライブのフォルダID

/**
 * Webアプリの初期表示
 */
function doGet(e) {
  // セッションチェック
  const userProperties = PropertiesService.getUserProperties();
  const session = userProperties.getProperty('session');
  const sessionTime = userProperties.getProperty('sessionTime');
  
  // セッションが有効かチェック（30分）
  if (session && sessionTime) {
    const now = new Date().getTime();
    const sessionStart = parseInt(sessionTime);
    const thirtyMinutes = 30 * 60 * 1000;
    
    if (now - sessionStart < thirtyMinutes) {
      // セッション有効 - 編集画面を表示
      return HtmlService.createTemplateFromFile('Editor')
        .evaluate()
        .setTitle('SRC JSON編集')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
  }
  
  // セッション無効 - ログイン画面を表示
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('SRC JSON編集 - ログイン')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * HTMLファイルをインクルード
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * パスワード検証
 */
function verifyPassword(password) {
  try {
    console.log('[v0] パスワード検証開始');
    const scriptProperties = PropertiesService.getScriptProperties();
    const adminPassword = scriptProperties.getProperty('ADMIN_PASSWORD');
    
    if (!adminPassword) {
      console.log('[v0] ADMIN_PASSWORDが設定されていません');
      return {
        success: false,
        message: 'パスワードが設定されていません。スクリプトプロパティに ADMIN_PASSWORD を設定してください。'
      };
    }
    
    if (password === adminPassword) {
      const userProperties = PropertiesService.getUserProperties();
      const sessionId = Utilities.getUuid();
      userProperties.setProperty('session', sessionId);
      userProperties.setProperty('sessionTime', new Date().getTime().toString());
      
      // セッションが正しく設定されたか確認
      const verifySession = userProperties.getProperty('session');
      console.log('[v0] セッション作成完了:', verifySession);
      
      // 少し待機してセッションが確実に保存されるようにする
      Utilities.sleep(500);
      
      return {
        success: true,
        message: 'ログインに成功しました'
      };
    } else {
      console.log('[v0] パスワードが一致しません');
      return {
        success: false,
        message: 'パスワードが正しくありません'
      };
    }
  } catch (error) {
    console.log('[v0] パスワード検証エラー:', error);
    return {
      success: false,
      message: 'エラーが発生しました: ' + error.message
    };
  }
}

/**
 * ログアウト
 */
function logout() {
  const userProperties = PropertiesService.getUserProperties();
  userProperties.deleteProperty('session');
  userProperties.deleteProperty('sessionTime');
  return { success: true };
}

/**
 * セッションチェック
 */
function checkSession() {
  const userProperties = PropertiesService.getUserProperties();
  const session = userProperties.getProperty('session');
  const sessionTime = userProperties.getProperty('sessionTime');
  
  if (!session || !sessionTime) {
    return { valid: false };
  }
  
  const now = new Date().getTime();
  const sessionStart = parseInt(sessionTime);
  const thirtyMinutes = 30 * 60 * 1000;
  
  if (now - sessionStart >= thirtyMinutes) {
    // セッション期限切れ
    logout();
    return { valid: false };
  }
  
  // セッション更新
  userProperties.setProperty('sessionTime', now.toString());
  return { valid: true };
}

/**
 * フォルダ内のJSONファイル一覧を取得
 */
function getJsonFiles() {
  try {
    console.log('[v0] getJsonFiles開始');
    
    // セッションチェック
    const sessionCheck = checkSession();
    console.log('[v0] セッションチェック結果:', sessionCheck);
    
    if (!sessionCheck.valid) {
      console.log('[v0] セッション無効');
      return { success: false, message: 'セッションが無効です。再ログインしてください。' };
    }
    
    const scriptProperties = PropertiesService.getScriptProperties();
    const folderId = scriptProperties.getProperty('FOLDER_ID');
    
    console.log('[v0] フォルダID:', folderId);
    
    if (!folderId) {
      console.log('[v0] FOLDER_IDが設定されていません');
      return {
        success: false,
        message: 'フォルダIDが設定されていません。スクリプトプロパティに FOLDER_ID を設定してください。\n\n設定方法：\n1. 「プロジェクトの設定」（歯車アイコン）をクリック\n2. 「スクリプト プロパティ」セクションで「プロパティを追加」\n3. プロパティ: FOLDER_ID\n4. 値: GoogleドライブのフォルダID'
      };
    }
    
    let folder;
    try {
      console.log('[v0] フォルダ取得試行:', folderId);
      folder = DriveApp.getFolderById(folderId);
      console.log('[v0] フォルダ取得成功:', folder.getName());
    } catch (e) {
      console.log('[v0] フォルダ取得エラー:', e);
      return {
        success: false,
        message: 'フォルダが見つかりません。\n\nFOLDER_ID: ' + folderId + '\n\nエラー: ' + e.message + '\n\nフォルダIDが正しいか確認してください。GoogleドライブのフォルダURLから取得できます。\n例: https://drive.google.com/drive/folders/【ここがフォルダID】'
      };
    }
    
    console.log('[v0] ファイル検索開始');
    
    // ----- ▼ 修正点 ▼ -----
    // MimeTypeで絞り込まず、全てのファイルを取得します。
    const files = folder.getFiles(); 
    // ----- ▲ 修正点 ▲ -----

    const jsonFiles = [];
    
    let fileCount = 0;
    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      fileCount++;
      console.log('[v0] ファイル発見:', fileName);
      
      // .jsonファイルのみ取得
      if (fileName.endsWith('.json')) {
        jsonFiles.push({
          id: file.getId(),
          name: fileName,
          lastModified: file.getLastUpdated().toISOString()
        });
        console.log('[v0] JSONファイル追加:', fileName);
      }
    }
    
    console.log('[v0] 検索完了 - 全ファイル数:', fileCount, 'JSONファイル数:', jsonFiles.length);
    
    if (jsonFiles.length === 0) {
      return {
        success: false,
        // メッセージを少し具体的に変更
        message: 'フォルダ内に .json 拡張子のファイルが見つかりませんでした。\n\nフォルダ: ' + folder.getName() + '\n検索した全ファイル数: ' + fileCount + '\n\n対象フォルダに .json 拡張子のファイルを追加してください。'
      };
    }
    
    // 最終更新日時でソート（新しい順）
    jsonFiles.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    
    return {
      success: true,
      files: jsonFiles
    };
  } catch (error) {
    console.log('[v0] getJsonFilesエラー:', error);
    return {
      success: false,
      message: 'エラーが発生しました: ' + error.message + '\n\nスタックトレース: ' + error.stack
    };
  }
}

/**
 * JSONファイルの内容を取得
 */
function getJsonContent(fileId) {
  try {
    // セッションチェック
    const sessionCheck = checkSession();
    if (!sessionCheck.valid) {
      return { success: false, message: 'セッションが無効です。再ログインしてください。' };
    }
    
    const file = DriveApp.getFileById(fileId);
    const content = file.getBlob().getDataAsString('UTF-8');
    const jsonData = JSON.parse(content);
    
    return {
      success: true,
      data: jsonData,
      fileName: file.getName()
    };
  } catch (error) {
    return {
      success: false,
      message: 'JSONの読み込みに失敗しました: ' + error.message
    };
  }
}

/**
 * JSONファイルを上書き保存
 */
function saveJsonContent(fileId, jsonData) {
  try {
    // セッションチェック
    const sessionCheck = checkSession();
    if (!sessionCheck.valid) {
      return { success: false, message: 'セッションが無効です。再ログインしてください。' };
    }
    
    // JSONの妥当性チェック
    if (!jsonData.title || !jsonData.startTime || !jsonData.endTime) {
      return {
        success: false,
        message: '必須項目（タイトル、開始日時、終了日時）が入力されていません。'
      };
    }
    
    const file = DriveApp.getFileById(fileId);
    const jsonString = JSON.stringify(jsonData, null, 2);
    
    // ファイルを上書き
    file.setContent(jsonString);
    
    return {
      success: true,
      message: '保存に成功しました',
      lastModified: file.getLastUpdated().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      message: '保存に失敗しました: ' + error.message
    };
  }
}

/**
 * 新規JSONファイルを作成
 */
function createNewJsonFile(fileName, jsonData) {
  try {
    // セッションチェック
    const sessionCheck = checkSession();
    if (!sessionCheck.valid) {
      return { success: false, message: 'セッションが無効です。再ログインしてください。' };
    }
    
    const scriptProperties = PropertiesService.getScriptProperties();
    const folderId = scriptProperties.getProperty('FOLDER_ID');
    
    if (!folderId) {
      return {
        success: false,
        message: 'フォルダIDが設定されていません。'
      };
    }
    
    const folder = DriveApp.getFolderById(folderId);
    const jsonString = JSON.stringify(jsonData, null, 2);
    
    // ファイル名に.jsonを追加（まだついていない場合）
    const fullFileName = fileName.endsWith('.json') ? fileName : fileName + '.json';
    
    // 新規ファイル作成
    const file = folder.createFile(fullFileName, jsonString, MimeType.PLAIN_TEXT);
    
    return {
      success: true,
      message: '新規ファイルを作成しました',
      fileId: file.getId(),
      fileName: file.getName()
    };
  } catch (error) {
    return {
      success: false,
      message: 'ファイル作成に失敗しました: ' + error.message
    };
  }
}

/**
 * JSONファイルをゴミ箱に移動
 */
function deleteJsonFile(fileId) {
  try {
    // セッションチェック
    const sessionCheck = checkSession();
    if (!sessionCheck.valid) {
      return { success: false, message: 'セッションが無効です。再ログインしてください。' };
    }
    
    if (!fileId) {
      return { success: false, message: 'ファイルIDが指定されていません。' };
    }

    const file = DriveApp.getFileById(fileId);
    const fileName = file.getName();
    
    // ファイルをゴミ箱に移動 (setTrashed(true))
    file.setTrashed(true);
    
    console.log('[v0] ファイルをゴミ箱に移動:', fileName, fileId);
    
    return {
      success: true,
      message: 'ファイル「' + fileName + '」をゴミ箱に移動しました。'
    };
  } catch (error) {
    console.log('[v0] deleteJsonFileエラー:', error);
    return {
      success: false,
      message: 'ファイルの削除に失敗しました: ' + error.message
    };
  }
}
