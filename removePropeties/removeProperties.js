/**
 * ======================================================================================
 * Google Drive ファイルプロパティ一括削除スクリプト
 * * 指定されたフォルダIDを起点に、すべてのサブフォルダを再帰的にスキャンし、
 * 検出されたPDFファイルおよびJSONファイルから、
 * 指定されたキーを持つカスタムプロパティを削除します。
 * * 【重要】
 * このスクリプトは「Drive API v2」を使用します。
 * GASの「サービス」メニューから「Drive API」を追加し、有効にしてください。
 * ======================================================================================
 */

/**
 * メイン関数：この関数を実行します。
 * 実行する前に、下の FOLDER_ID を対象フォルダのIDに書き換えてください。
 */
function mainRemoveFileProperties() { // 関数名を変更
  
  // ▼▼▼▼▼【要設定】▼▼▼▼▼
  // 対象のルートフォルダIDを指定してください。
  // フォルダのURLが "https://drive.google.com/drive/folders/ABCDEFG12345" の場合、
  // "ABCDEFG12345" の部分がフォルダIDです。
  const FOLDER_ID = '1yvdscBjiTHvpUvXSYx6gw9oJzU8Tkfd2';
  // ▲▲▲▲▲【要設定】▲▲▲▲▲

  // 削除するカスタムプロパティのキーを指定します。
  // (例: 'processed', 'status' など)
  const PROPERTY_KEY = 'processed';

  // --- 処理開始 ---

  // [設定チェック]
  // FOLDER_IDが初期値のまま、または空文字の場合は、設定を促すメッセージを表示して処理を中断します。
  if (FOLDER_ID === 'YOUR_FOLDER_ID_HERE' || FOLDER_ID === '') {
    const message = 'スクリプトを編集して、FOLDER_ID に対象のフォルダIDを設定してください。';
    console.error(message);
    
    // スクリプトがスプレッドシートに紐づいている場合、UIでアラートを表示します。
    try {
      // SpreadsheetApp.getUi() はスタンドアロン環境では失敗するため、try...catchで囲みます。
      SpreadsheetApp.getUi().alert(message);
    } catch (e) {
      // スタンドアロンの場合はコンソールエラーのみで、ここでは何もしません。
    }
    return; // 処理を終了
  }

  // [メイン処理]
  try {
    // 1. FOLDER_IDを使用して、処理の起点となるフォルダオブジェクトを取得します。
    const rootFolder = DriveApp.getFolderById(FOLDER_ID);
    
    // 2. 処理開始のログを出力します。
    console.log(`処理を開始します。`);
    console.log(`対象フォルダ: ${rootFolder.getName()} (ID: ${FOLDER_ID})`);
    console.log(`削除するキー: ${PROPERTY_KEY}`);
    
    // 3. フォルダの再帰処理を開始します。
    // processFolderRecursive関数が、フォルダ内のファイル処理とサブフォルダへの再帰呼び出しを行います。
    processFolderRecursive(rootFolder, PROPERTY_KEY);
    
    // 4. すべての再帰処理が完了したら、完了ログを出力します。
    console.log('すべての処理が完了しました。');
    
  } catch (e) {
    // [エラーハンドリング]
    // フォルダIDが不正でフォルダが見つからなかった場合のエラーを個別に捕捉します。
    if (e.toString().includes('No folder with id')) {
      console.error(`指定されたフォルダIDが見つかりません: ${FOLDER_ID}`);
    } else {
      // Drive APIが無効な場合のエラーは removeCustomProperty 関数側で捕捉されます。
      // ここでは、その他の予期せぬエラー（例：対象フォルダへのアクセス権がない）を捕捉します。
      console.error(`処理の開始中にエラーが発生しました: ${e.toString()}`);
    }
  }
}

/**
 * フォルダを再帰的に処理する関数
 * * @param {GoogleAppsScript.Drive.Folder} folder - 処理対象のフォルダ
 * @param {string} propertyKey - 削除するプロパティキー
 */
function processFolderRecursive(folder, propertyKey) {
  // 現在処理中のフォルダ名をログに出力します。
  console.log(`フォルダをスキャン中: ${folder.getName()}`);

  // 1. フォルダ内のPDFファイルを処理
  try {
    // MimeType.PDF の代わりに文字列 "application/pdf" を使用
    // getFilesByTypeはイテレータ(FileIterator)を返します。
    const pdfFiles = folder.getFilesByType("application/pdf");
    // .hasNext() と .next() を使ってファイルがなくなるまでループ処理します。
    while (pdfFiles.hasNext()) {
      const file = pdfFiles.next();
      // 個々のファイルのプロパティ削除を実行する関数を呼び出します。
      removeCustomProperty(file, propertyKey);
    }
  } catch (e) {
    // PDFファイルのリスト取得や処理中にエラーが発生しても、処理を続行します。
    console.error(`PDFファイル一覧の取得または処理中にエラー (フォルダ: ${folder.getName()}): ${e.toString()}`);
  }

  // 2. フォルダ内のJSONファイルを処理
  try {
    // MimeType.JSON の代わりに文字列 "application/json" を使用
    const jsonFiles = folder.getFilesByType("application/json");
    while (jsonFiles.hasNext()) {
      const file = jsonFiles.next();
      removeCustomProperty(file, propertyKey);
    }
  } catch (e) {
    // JSONファイルのリスト取得や処理中にエラーが発生しても、処理を続行します。
    console.error(`JSONファイル一覧の取得または処理中にエラー (フォルダ: ${folder.getName()}): ${e.toString()}`);
  }

  // 3. サブフォルダを再帰的に処理
  // (★ 修正 ★ 不要なJSON処理ブロックを削除しました)
  try {
    // フォルダ内のサブフォルダを取得します (FolderIterator)。
    const subFolders = folder.getFolders();
    while (subFolders.hasNext()) {
      const subFolder = subFolders.next();
      // この関数自身 (processFolderRecursive) を、見つかったサブフォルダを引数にして呼び出します（再帰）。
      processFolderRecursive(subFolder, propertyKey);
    }
  } catch (e) {
    // サブフォルダのリスト取得中にエラーが発生しても、処理を続行します。
    console.error(`サブフォルダの取得中にエラー (フォルダ: ${folder.getName()}): ${e.toString()}`);
  }
}

/**
 * 指定されたファイルからカスタムプロパティを削除する関数
 * * @param {GoogleAppsScript.Drive.File} file - 処理対象のファイル
 * @param {string} propertyKey - 削除するプロパティキー
 */
function removeCustomProperty(file, propertyKey) {
  const fileId = file.getId();
  const fileName = file.getName();
  
  try {
    /*
     * Drive API v2 (Drive) を使用してプロパティを削除します。
     * これは標準の DriveApp ではなく、「高度なGoogleサービス」で有効化が必要です。
     *
     * Drive.Properties.remove(fileId, key, {visibility: 'PUBLIC' | 'PRIVATE'})
     *
     * [仕様]
     * このキーのプロパティが存在しない場合、このAPI呼び出しはエラーにならず、
     * 単に何もせずに正常終了します。
     */
    Drive.Properties.remove(fileId, propertyKey, { visibility: 'PUBLIC' });
    
    // プロパティが存在しなかった場合も「成功」としてログ出力されます。
    console.log(`[削除成功] ${fileName} (ID: ${fileId}) からキー '${propertyKey}' を削除しました (または元から存在しません)`);
    
  } catch (e) {
    // [エラーハンドリング]
    
    // Drive API v2 が有効になっていない場合のエラーを検知します。
    // "Drive.Properties is not defined" または "Drive is not defined" が典型的なエラーメッセージです。
    if (e.toString().includes("Drive.Properties is not defined") || e.toString().includes("Drive is not defined")) {
      const errorMsg = 'Drive API v2 が有効になっていません。「セットアップガイド.md」の手順に従ってAPIを有効にしてください。処理を中止します。';
      console.error(errorMsg);
      
      // これはスクリプトの前提条件に関わる致命的なエラーのため、
      // 処理を確実に中断させるためにエラーを再スローします。
      // これにより、mainRemoveFileProperties の catch ブロックに処理が移ります。
      throw new Error(errorMsg); 
    }
    
    // Drive API v2 は有効だが、その他のAPI呼び出しエラー（例：アクセス権限がないなど）が発生した場合。
    console.error(`[削除失敗] ${fileName} (ID: ${fileId}) - ${e.toString()}`);
  }
}