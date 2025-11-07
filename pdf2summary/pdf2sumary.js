/**
 * @OnlyCurrentDoc
 *
 * PDF情報抽出＆JSON保存システム (v13 - API失敗時フラグ修正)
 *
 * v12.1 をベースに、Gemini APIから有効なJSONが取得できなかった場合
 * (extractedData が null または title が無い場合)、
 * 処理済みフラグを立てずにスキップし、次回再試行するように修正。
 *
 * 【スクリプトの動作概要】
 * 1. スクリプトプロパティから設定値（APIキー、PDFフォルダID、JSONフォルダID）を読み込みます。
 * 2. Drive API v2 を使い、PDFフォルダID配下を再帰的に検索し、
 * 'processed' = 'true' (PRIVATE) のカスタムプロパティが「付いていない」PDFファイルの一覧を取得します。(findPdfsRecursive)
 * 3. 取得した未処理PDFファイル（files）を1件ずつループ処理します。
 * 4. PDFのフォルダ階層（カテゴリ/サブカテゴリ）を取得します。(getFolderHierarchy)
 * 5. PDFファイルをGemini 2.5 Flash APIに送信し、内容を解析させ、JSON形式で情報（表題、概要、日時等）を受け取ります。(parsePdfWithGemini)
 * 6. (v13) Gemini APIが失敗、または有効な情報（title）を返さなかった場合：
 * - 警告ログを出し、このファイルの処理を「中断」します。
 * - 処理済みフラグを「立てない」ため、次回のトリガー実行時に再試行されます。
 * 7. (v13) Gemini APIが成功した場合：
 * - 抽出したJSONデータに、フォルダ階層と元のPDFへのリンクを追加します。
 * - JSONデータを、JSON出力フォルダにファイルとして保存します。(saveDataAsJson)
 * - 元のPDFファイルに対し、Drive API v2 を使い 'processed' = 'true' (PRIVATE) のカスタムプロパティを設定します。(markFileAsProcessed)
 *
 * 【429エラー（クォータ超過）の処理】
 * - parsePdfWithGemini で 429 を検知すると、推奨待機秒数を含むエラーをスローします。
 * - processPdfsToJson の catch ブロックがこのエラーを捕捉し、指定秒数待機 (Utilities.sleep) します。
 * - 待機後、Gemini APIの呼び出しから処理を「リトライ」します。
 * - (v13) リトライ後もGeminiが失敗した場合は、同様にフラグを立てずにスキップします。
 */

// ▼▼▼【重要】ここから設定項目 ▼▼▼

// スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）から設定値を読み込みます。
// コード内に直接キーやIDを書かないためのセキュリティ対策です。
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();

// 1. Google AI Studio または Cloud Console で取得した Gemini API キー
const GEMINI_API_KEY = SCRIPT_PROPERTIES.getProperty('GEMINI_API_KEY');
// 2. 処理対象のPDFが格納されている「ルート」フォルダID
const PDF_DRIVE_FOLDER_ID = SCRIPT_PROPERTIES.getProperty('PDF_DRIVE_FOLDER_ID');
// 3. 抽出したJSONを保存する「出力先」フォルダID
const JSON_OUTPUT_FOLDER_ID = SCRIPT_PROPERTIES.getProperty('JSON_OUTPUT_FOLDER_ID');

// ▲▲▲ 設定項目ここまで ▲▲▲


/**
 * メインの処理を実行する関数。この関数をトリガーで定期実行します。
 */
function processPdfsToJson() {
  
  // --- [1. 設定値のチェック] ---
  // スクリプトプロパティが正しく設定されているかを確認します。
  if (!GEMINI_API_KEY || !PDF_DRIVE_FOLDER_ID || !JSON_OUTPUT_FOLDER_ID) {
    console.error("スクリプトプロパティ 'GEMINI_API_KEY', 'PDF_DRIVE_FOLDER_ID', 'JSON_OUTPUT_FOLDER_ID' のいずれかが設定されていません。");
    return; // 設定不備のため処理終了
  }
  
  // --- [2. Drive API v2 サービスの有効化チェック] ---
  // このスクリプトは 'Drive' (Drive API v2) という高度なサービスを使用します。
  // 'Drive' オブジェクトが存在するか、その中の 'Properties' や 'Files' が使えるかを確認します。
  if (typeof Drive === 'undefined' || typeof Drive.Properties === 'undefined' || typeof Drive.Files === 'undefined') {
    // v12 構文エラー修正
    console.error('Google Drive API (v2) の拡張サービスが有効になっていません。[appsscript.json] で "version": "v2" を設定してください。');
    return; // APIが有効でないため処理終了
  }

  // --- [3. 未処理PDFの取得] ---
  console.log(`ルートフォルダ (${PDF_DRIVE_FOLDER_ID}) から未処理PDFの検索を開始します...`);
  // 'processed' フラグが付いていないPDFを再帰的に検索します。
  const files = findPdfsRecursive(PDF_DRIVE_FOLDER_ID);
  
  if (files.length === 0) {
    console.log("処理対象の新しいPDFファイルはありませんでした。");
    return; // 対象ファイルがないため処理終了
  }

  console.log(`${files.length}件の新しいPDFファイルを処理します。`);

  // --- [4. 各ファイルを順次処理] ---
  files.forEach(file => {
    try {
      // file オブジェクトは Drive.Files.list (v2) から返された最小限の情報 (id, title など) を含みます。
      console.log(`処理開始: ${file.title} (ID: ${file.id})`);

      // v6 フォルダ階層（カテゴリ、サブカテゴリ）を取得します。
      const hierarchy = getFolderHierarchy(file.id, PDF_DRIVE_FOLDER_ID);

      // 4a. Gemini APIでPDFを解析し、構造化データ(JSON)を取得します。
      const extractedData = parsePdfWithGemini(file); 

      // ★★★ 修正 (v13) ★★★
      // [API失敗時のスキップ処理]
      // 抽出データが null であるか、または必須項目である 'title' が存在しない場合...
      if (!extractedData || !extractedData.title) {
        // 警告ログを出し、このファイルの処理をスキップします。
        console.warn(`Gemini APIから有効な情報が抽出できませんでした。フラグを立てずにスキップします (次回再試行): ${file.title}`);
        // markFileAsProcessed(file.id); // <-- (v13) 処理済みフラグを「立てない」ことが重要
        return; // forEach の次のループに移る
      }

      // 4b. 抽出データをJSONファイルとして保存します。
      //    (extractedData に階層情報やPDFリンクを追記する処理もこの中で行われます)
      saveDataAsJson(extractedData, file, JSON_OUTPUT_FOLDER_ID, hierarchy);

      // 4c. 処理済みフラグ（カスタムプロパティ）を元のPDFに設定します。
      markFileAsProcessed(file.id);
      console.log(`処理完了 (JSON保存): ${file.title}`);

    } catch (e) {
      // --- [5. エラーハンドリング (429クォータ超過 と その他)] ---
      
      // 429エラー (クォータ超過) の場合
      // parsePdfWithGemini がスローした "QuotaExceeded_429: [秒数]" というエラーを捕捉します。
      if (e.message.startsWith("QuotaExceeded_429")) {
        
        // 階層情報はリトライ処理ブロックの外側で取得済みなので再利用（v13修正：元のコードではリトライブロック内でも取得していたが、ここでは外側のhierarchyを使う想定）
        // ※元のコードのロジックを尊重し、リトライブロック内でもう一度取得します (getFolderHierarchy(file.id, PDF_DRIVE_FOLDER_ID))
        //   (ただし、ファイルが移動していない限り hierarchy と hierarchyRetry は同じはずです)
        const hierarchyRetry = getFolderHierarchy(file.id, PDF_DRIVE_FOLDER_ID);

        // エラーメッセージから待機すべき秒数を抽出します (例: "30")
        const retrySeconds = parseInt(e.message.split(': ')[1], 10) || 30; // 抽出失敗時は30秒
        console.log(`クォータ超過(RPM制限の可能性)のため、${retrySeconds}秒待機します...`);
        
        // [スリープ実行]
        Utilities.sleep(retrySeconds * 1000); // ミリ秒単位で指定

        // [リトライ処理]
        try {
          console.log(`リトライ実行: ${file.title}`);
          // 5a. Gemini APIを再実行
          const extractedDataRetry = parsePdfWithGemini(file); 

          // ★★★ 修正 (v13) ★★★
          // [リトライ失敗時のスキップ処理]
          // リトライ後も抽出データが不十分な場合は「フラグを立てずに」スキップします。
          if (!extractedDataRetry || !extractedDataRetry.title) {
            console.warn(`リトライ後もGemini APIから有効な情報が抽出できませんでした。フラグを立てずにスキップします (次回再試行): ${file.title}`);
            // markFileAsProcessed(file.id); // <-- (v13) 同様にフラグを立てない
            return; // forEach の次のループに移る
          }

          // 5b. JSON保存 (リトライ成功時)
          saveDataAsJson(extractedDataRetry, file, JSON_OUTPUT_FOLDER_ID, hierarchyRetry);
          // 5c. フラグ設定 (リトライ成功時)
          markFileAsProcessed(file.id);
          console.log(`リトライ処理完了 (JSON保存): ${file.title}`);
        
        } catch (retryError) {
          // リトライ処理（5a, 5b, 5c）の最中に、429以外のエラーが発生した場合
          console.error(`リトライ処理中にもエラーが発生しました: ${file.title} - ${retryError.toString()}`);
          // この場合もフラグは立たない
        }

      } else {
        // 429以外のエラー (JSON保存失敗、フラグ設定失敗、Geminiの500エラーなど)
        console.error(`ファイル処理中にエラーが発生しました: ${file.title || file.id} - ${e.toString()}`);
        // この場合、markFileAsProcessed は呼ばれていないため、
        // 次回の実行で自動的に再試行されます。
      }
    }
  });
}


/**
 * v11: 指定されたフォルダID配下を再帰的に検索し、「未処理」のPDFファイル一覧を返します。
 * (Drive API v2 を使用)
 *
 * @param {string} folderId - 検索を開始するフォルダのID
 * @return {Array<Object>} Drive API v2 の File リソースの配列 (id, title などを含む)
 */
function findPdfsRecursive(folderId) {
  let allFiles = []; // この階層で見つかった未処理PDFを格納する配列

  // --- 1. 指定フォルダ直下の「未処理PDF」を検索 ---
  
  // Drive API v2 (JScript) 形式の検索クエリ
  // 'folderId' in parents : 指定フォルダ直下にある
  // and mimeType = 'application/pdf' : PDFファイル
  // and not properties has { ... } : そして、指定のカスタムプロパティを「持っていない」
  //   key='processed', value='true', visibility='PRIVATE'
  // and trashed = false : ゴミ箱に入っていない
  // v12.1: visibility='PRIVATE' で検索 (v12.1での修正点)
  const pdfSearchQuery = `'${folderId}' in parents and mimeType = 'application/pdf' and not properties has { key='processed' and value='true' and visibility='PRIVATE' } and trashed = false`;
  
  try {
    let pageToken; // 検索結果が複数ページにわたる場合のためのトークン
    do {
      // Drive.Files.list は Drive API v2 のメソッド
      const response = Drive.Files.list({
        q: pdfSearchQuery, // 検索クエリ
        fields: "nextPageToken, items(id, title, webViewLink, originalFilename, alternateLink)", // 取得するフィールドを限定
        pageToken: pageToken, // 2ページ目以降のトークン
        maxResults: 100 // 1リクエストあたりの最大取得件数 (v2 のパラメータ名)
      });
      
      if (response.items && response.items.length > 0) {
        // 見つかったファイルの配列を allFiles に連結
        allFiles = allFiles.concat(response.items);
      }
      pageToken = response.nextPageToken; // 次ページのトークンを取得
    } while (pageToken); // 次ページのトークンがある限りループ
    
  } catch (e) {
    console.error(`Drive API (v2) でPDF検索に失敗しました (FolderID: ${folderId}): ${e.toString()}`);
    console.error(`失敗したクエリ (v2): ${pdfSearchQuery}`);
    // エラーが発生しても、サブフォルダの検索処理は続行する
  }

  // --- 2. 指定フォルダ直下の「サブフォルダ」を検索 ---
  
  // 'folderId' in parents : 指定フォルダ直下にある
  // and mimeType = 'application/vnd.google-apps.folder' : フォルダ
  // and trashed = false : ゴミ箱に入っていない
  const folderSearchQuery = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
  try {
    let pageToken;
    do {
      const response = Drive.Files.list({
        q: folderSearchQuery,
        fields: "nextPageToken, items(id, title)", // フォルダIDとタイトルのみ取得
        pageToken: pageToken,
        maxResults: 100
      });
      
      if (response.items && response.items.length > 0) {
        // --- 3. 見つかったサブフォルダに対して、再帰呼び出し ---
        for (const subFolder of response.items) {
          console.log(`サブフォルダを検索中: ${subFolder.title} (ID: ${subFolder.id})`);
          
          // この関数 (findPdfsRecursive) 自身を、サブフォルダIDで呼び出す
          const filesInSubFolder = findPdfsRecursive(subFolder.id);
          
          // サブフォルダで見つかった未処理PDFの配列を allFiles に連結
          allFiles = allFiles.concat(filesInSubFolder);
        }
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

  } catch (e) {
    console.error(`Drive API (v2) でサブフォルダ検索に失敗しました (FolderID: ${folderId}): ${e.toString()}`);
    console.error(`失敗したクエリ (v2): ${folderSearchQuery}`);
  }

  // この階層と、すべてのサブ階層で見つかった未処理PDFの完全な配列を返す
  return allFiles;
}


/**
 * Gemini API (gemini-2.5-flash) にPDFファイル全体を送信し、指定された情報を抽出します。
 *
 * @param {Object} file - Drive API v2 の File リソース (id, title を含む)
 * @return {Object|null} 抽出されたデータ (JSONオブジェクト)、または失敗時に null
 * @throws {Error} クォータ超過(429)の場合、"QuotaExceeded_429: [秒数]" というエラーをスローします。
 */
function parsePdfWithGemini(file) {
  
  // DriveApp (v2 APIから取得したIDで v1 API を使う) を使用してファイルの実体(Blob)を取得
  const blob = DriveApp.getFileById(file.id).getBlob();
  // BlobをBase64文字列にエンコードします。
  const base64Data = Utilities.base64Encode(blob.getBytes());
  const mimeType = blob.getContentType();

  if (mimeType !== 'application/pdf') {
    console.error(`ファイルがPDFではありません: ${mimeType}`);
    return null; // PDFでなければ処理中断
  }

  // Gemini API (v1beta) のエンドポイントURL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  // Geminiに送信するプロンプト。抽出したいJSONの形式を指定します。
  const prompt = `
このPDFファイルから、以下の情報を抽出し、指定されたJSON形式で返してください。
PDF全体を読み取り、イベントや計画の情報を特定してください。

- "title": イベントや計画の正式な件名 (例: "2025年度 新入生歓迎イベント", "2025年度 10月度定例MTG")
- "description": 予定の「概要」または「目的」をまとめてください。
- "startTime": イベントの「実施」の開始日時 (ISO 8601形式: YYYY-MM-DDTHH:MM:SS)。「準備」の日ではなく、「実施」日または「当日」の開始時刻（例: 集合時間）を採用してください。
- "endTime": イベントの「実施」の終了日時 (ISO 8601形式)。「報告」日ではなく、「実施」日または「当日」の終了時刻（例: 解散時間）を採用してください。見つからなければ開始の8時間後としてください。
- "location": 開催場所 (例: "〇〇キャンパス 体育館", "Zoomオンラインミーティング")

もしJSON形式で返せない、または主要な予定が見つからない場合は、"title": null のみ含むJSONを返してください。
`;

  // Gemini API へのリクエストペイロード（本体）
  const payload = {
    contents: [{
      parts: [
        { "text": prompt }, // 1. テキスト（指示）
        { "inlineData": {    // 2. PDFデータ（Base64）
            "mimeType": mimeType,
            "data": base64Data
          }
        }
      ]
    }],
    generationConfig: {
      // APIにJSON形式でレスポンスを返すよう指示
      responseMimeType: "application/json",
    }
  };

  // UrlFetchApp でのHTTPリクエストオプション
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload), // ペイロードをJSON文字列に変換
    muteHttpExceptions: true // 4xx や 5xx エラーが発生しても例外をスローせず、レスポンスを返す
  };

  // --- APIリクエスト実行 ---
  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode(); // HTTPステータスコード (200, 429, 500 など)
  const responseBody = response.getContentText(); // レスポンス本文

  // --- レスポンス分岐 ---
  
  // 1. 成功 (200 OK)
  if (responseCode === 200) {
    const result = JSON.parse(responseBody);
    
    // レスポンスの構造を安全にチェック
    // result.candidates[0].content.parts[0].text に抽出されたJSON文字列が入っているはず
    if (result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts[0]) {
      const jsonText = result.candidates[0].content.parts[0].text;
      return JSON.parse(jsonText); // 抽出されたJSON文字列をパースして返す
    } else {
      // 成功(200)したが、期待した構造のレスポンスが返ってこなかった場合
      console.error("Gemini APIからのレスポンス形式が予期したものではありません。", responseBody);
      return null;
    }
    
  // 2. クォータ超過 (429 Too Many Requests)
  } else if (responseCode === 429) {
    console.warn(`APIクォータ超過(429)を検知しました。`);
    let retrySeconds = 30; // デフォルトの待機時間（30秒）
    
    try {
      // エラーレスポンス (responseBody) に推奨待機時間が含まれているか試行
      const errorBody = JSON.parse(responseBody);
      // 'error.details' 配列から 'RetryInfo' を探し、'retryDelay' (例: "60s") を取得
      const retryDelayStr = errorBody.error.details.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
      
      if (retryDelayStr) {
        // "60s" から 's' を取り除き、数値(60)に変換。マージンとして1秒追加。
        retrySeconds = parseInt(retryDelayStr.replace('s', ''), 10) + 1; 
      }
    } catch (parseError) {
      // エラーレスポンスのJSONパースに失敗した場合は、デフォルト値(30秒)を使用
    }
    
    // メイン関数 (processPdfsToJson) の catch ブロックで捕捉できるよう、
    // 待機秒数を含むカスタムエラーをスローします。
    throw new Error(`QuotaExceeded_429: ${retrySeconds}`);
    
  // 3. その他のAPIエラー (500 Internal Server Error など)
  } else {
    console.error(`Gemini APIエラー: Status ${responseCode} - ${responseBody}`);
    return null;
  }
}

/**
 * 抽出したデータを指定されたフォルダにJSONファイルとして保存します。(v6)
 *
 * @param {Object} extractedData - Gemini APIが抽出したJSONデータ
 * @param {Object} originalFile - 元のPDFファイル (Drive API v2 File リソース)
 * @param {string} outputFolderId - JSONの保存先フォルダID
 * @param {Object} hierarchy - {category: string|null, subCategory: string|null}
 */
function saveDataAsJson(extractedData, originalFile, outputFolderId, hierarchy) {
  try {
    // DriveApp (v1 API) を使って出力先フォルダを取得
    const outputFolder = DriveApp.getFolderById(outputFolderId);
    
    // 元のファイル名 (例: "イベント案内.pdf") を取得
    let baseName = originalFile.title;
    // 末尾が ".pdf" (大文字小文字問わず) なら、それを除去 (例: "イベント案内")
    if (baseName.toLowerCase().endsWith('.pdf')) {
      baseName = baseName.substring(0, baseName.length - 4);
    }
    
    // この時点でのJSONファイル名 (例: "イベント案内.json")
    let jsonFileName = `${baseName}.json`;

    // ★ 新規 (v6) ★ 抽出データに、フォルダ階層情報を追加
    extractedData.category = hierarchy.category || null;
    extractedData.subCategory = hierarchy.subCategory || null;

    // 抽出データに、元のPDFへの参照リンクを追加
    extractedData.sourcePdf = {
      id: originalFile.id,
      title: originalFile.title,
      // ★ 修正 (v11) ★ v4の alternateLink (v2で取得) を使用
      // (alternateLink は v2 API で取得した、ブラウザで開くためのリンク)
      link: originalFile.alternateLink 
    };

    // JSONオブジェクトを、読みやすい形式（インデント付き）の文字列に変換
    const jsonContent = JSON.stringify(extractedData, null, 2); 
    
    // [上書き防止処理]
    // 出力先フォルダに、同じ名前のJSONファイルが既に存在するか検索
    const existingFiles = outputFolder.getFilesByName(jsonFileName);
    
    if (existingFiles.hasNext()) {
      // 既存ファイルがある場合 (通常は無いはずだが念のため)
      // 名前にタイムスタンプ (Unix time) を付与して重複を回避
      const timestamp = new Date().getTime();
      jsonFileName = `${baseName}_${timestamp}.json`; // 例: "イベント案内_1678886400000.json"
      console.log(`JSONファイル名が重複したため、変更します: ${jsonFileName}`);
    }

    // JSON文字列から Blob (ファイルの中身) を作成
    // MimeTypeを 'application/json' (string) に設定 (v3)
    const blob = Utilities.newBlob(jsonContent, 'application/json', jsonFileName);
    
    // Blobからファイルを作成
    outputFolder.createFile(blob);
    console.log(`JSONファイルを作成しました: ${jsonFileName}`);

  } catch (e) {
    console.error(`JSONファイルの保存に失敗しました: ${e.toString()}`);
    // このエラーはメインの try...catch にスローし、
    // 処理済みフラグが立たないようにします。
    throw e; 
  }
}


/**
 * ★★★ 修正 (v12.1) ★★★
 * ファイルに「処理済み」であることを示すカスタムプロパティを設定します。
 * visibility を 'PUBLIC' から 'PRIVATE' に修正し、検索クエリ (findPdfsRecursive) と一致させます。
 *
 * @param {string} fileId - プロパティを設定するファイルのID
 */
function markFileAsProcessed(fileId) {
  try {
    // 設定するプロパティの定義
    const property = {
      key: 'processed',
      value: 'true',
      visibility: 'PRIVATE' // ★ v12.1 修正 ★
                            // 'PRIVATE' は、このスクリプト（認証済みユーザー）からのみ
                            // 読み書き可能で、検索クエリにも反映されます。
    };
    
    // v11: v2 の構文 (Drive.Properties.insert) を使用してプロパティを挿入（または更新）
    Drive.Properties.insert(property, fileId);
    
    console.log(`ファイルに処理済みフラグを設定しました: ${fileId}`);
    
  } catch (e) {
    console.error(`処理済みフラグの設定に失敗しました (v2): ${fileId} - ${e.toString()}`);
    // このエラーはリトライしても解決しない可能性が高いため（権限問題など）、
    // メインの try...catch にスローします。
    throw e;
  }
}

/**
 * ファイルIDから親フォルダを遡り、指定されたルートフォルダの
 * 1階層下（カテゴリ）と2階層下（サブカテゴリ）のフォルダ名を取得します。(v6)
 * (DriveApp (v1) を使用)
 *
 * @param {string} fileId - 調査対象のファイルID
 * @param {string} rootFolderId - 遡上を停止するルートフォルダのID
 * @return {Object} { category: string|null, subCategory: string|null }
 */
function getFolderHierarchy(fileId, rootFolderId) {
  let pathNames = []; // 遡ったフォルダ名を格納する配列 (例: ['サブA', 'カテゴリB'])
  try {
    // v1 API (DriveApp) でファイルを取得
    const file = DriveApp.getFileById(fileId);
    if (!file.getParents().hasNext()) {
      return { category: null, subCategory: null }; // 親がいない (マイドライブ直下など)
    }
    
    // ファイルの（最初の）親フォルダを取得
    let currentFolder = file.getParents().next();
    
    // 無限ループ防止のため、最大5階層まで遡る
    for (let i = 0; i < 5; i++) {
      // フォルダが存在しない、または指定されたルートフォルダIDに到達したらループを抜ける
      if (!currentFolder || currentFolder.getId() === rootFolderId) {
        break; 
      }
      
      // フォルダ名を配列の「先頭」に追加
      pathNames.push(currentFolder.getName());
      
      // さらにその親フォルダを取得
      if (currentFolder.getParents().hasNext()) {
        currentFolder = currentFolder.getParents().next();
      } else {
        break; // 親がいない（マイドライブのルートなど）
      }
    }
    
    // この時点で pathNames は [サブカテゴリ, カテゴリ] の順（ファイルに近い順）になっている
    pathNames.reverse();
    // パスを [カテゴリ, サブカテゴリ, ...] の順に並び替え
    
    // 0番目をカテゴリ、1番目をサブカテゴリとして返す
    const category = pathNames.length > 0 ? pathNames[0] : null;
    const subCategory = pathNames.length > 1 ? pathNames[1] : null;

    return { category: category, subCategory: subCategory };
    
  } catch (e) {
    // ファイルが見つからない、権限がないなどのエラー
    console.error(`フォルダ階層の取得に失敗しました (FileID: ${fileId}): ${e}`);
    return { category: null, subCategory: null }; // 失敗時は null を返す
  }
}