/**
 * @OnlyCurrentDoc
 *
 * JSON自動カレンダー登録システム (v3.2 - CacheService/議事録/キャッシュクリア対応)
 *
 * 指定されたGoogle Driveフォルダ内のJSONファイルを読み取り、
 * その内容（日時、タイトルなど）を使って、
 * 指定されたGoogleカレンダーに予定を登録します。
 *
 * 【v3.x系の主な動作ロジック】
 * 1. 従来の「未処理のみ検索」を廃止し、Driveフォルダ内の「すべてのJSON」を取得します。(getUnprocessedJsons)
 * 2. 取得したJSONファイルごとに、ファイルに 'processed' (PUBLIC) フラグが「付いているか (isProcessed)」を確認します。
 * 3. 同時に、JSON内の 'subCategory' をキーとして、それが「CacheServiceに存在するか (isCached)」を確認します。
 * 4. この2つのフラグの組み合わせで、処理を分岐します。
 *
 * 【v3.1 議事録ロジック】
 * - "category" が "議事録" の場合、キャッシュを無視した特別処理を行います。
 * - (A) 未処理(isProcessed=false) -> 常に登録し、キャッシュとフラグを設定。
 * - (B) 処理済み(isProcessed=true) -> 常に無視。
 *
 * 【v3.0 標準ロジック (議事録以外)】
 * - (A) 未処理(isProcessed=false):
 * - (A-1) キャッシュあり(isCached=true): [実行中セッションでの重複] -> スキップし、フラグのみ設定。
 * - (A-2) キャッシュなし(isCached=false): [新規登録対象] -> カレンダー登録し、キャッシュとフラグを設定。
 * - (B) 処理済み(isProcessed=true):
 * - (B-1) キャッシュあり(isCached=true): [正常な状態] -> 無視。
 * - (B-2) キャッシュなし(isCached=false): [キャッシュ切れ] -> キャッシュのみ再構築 (B-1の状態に戻す)。
 *
 * 【v3.2 キャッシュクリア】
 * - すべてのファイルの処理が完了した後、その実行中に遭遇した 'subCategory' のキャッシュをすべて削除 (cache.removeAll) します。
 * - これにより、CacheServiceは「実行中（セッション内）の重複防止」専用として機能し、次回の実行は必ずキャッシュゼロから開始されます。
 */

// ▼▼▼【重要】ここから設定項目 ▼▼▼
// スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）から設定値を読み込みます。
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
// 1. 処理対象のJSONファイルが格納されているフォルダID
const DRIVE_FOLDER_ID = SCRIPT_PROPERTIES.getProperty('DRIVE_FOLDER_ID');
// 2. 予定を登録する対象のカレンダーID (例: xxx@group.calendar.google.com)
const CALENDAR_ID = SCRIPT_PROPERTIES.getProperty('CALENDAR_ID');
// ▲▲▲ 設定項目ここまで ▲▲▲


/**
 * メインの処理を実行する関数。この関数をトリガーで定期実行します。
 * (★★★ CacheService による重複チェック機能を追加 ★★★)
 */
function processJsonsToCalendar() {
  
  // --- [1. 設定値のチェック] ---
  if (!DRIVE_FOLDER_ID || !CALENDAR_ID) {
    console.error("スクリプトプロパティ 'DRIVE_FOLDER_ID' または 'CALENDAR_ID' が設定されていません。");
    return; // 処理中断
  }
  
  // --- [2. Drive API v2 (Drive) の有効化チェック] ---
  // Drive.Properties (カスタムプロパティ用) や Drive.Files (検索用) が必要です。
  if (typeof Drive === 'undefined' || typeof Drive.Properties === 'undefined') {
    console.error("Google Drive APIの拡張サービスが有効になっていません。[サービス]メニューからDrive APIを追加してください。");
    return; // 処理中断
  }
  
  // ★★★ 変更 ★★★
  // --- [3. Calendar API v3 (Calendar) の有効化チェック] ---
  // カレンダー登録(Calendar.Events.insert) と 拡張プロパティ(sharedExtendedProperty) の書き込みに必要です。
  if (typeof Calendar === 'undefined') {
    console.error("Google Calendar API (v3) 拡張サービスが有効になっていません。[サービス]メニューからCalendar APIを追加してください。");
    return; // 処理中断
  }

  // ★★★ 追加 ★★★
  // --- [4. CacheService の取得] ---
  // スクリプトキャッシュを取得（有効期間は最大6時間 = 21600秒）
  // v3.2により、実質「実行セッション中のみ」の利用となります。
  const cache = CacheService.getScriptCache();

  // ★★★ 変更 (v3) ★★★
  // --- [5. 対象JSONファイルの取得] ---
  // 'processed' フラグに関わらず、フォルダ内の「すべてのJSON」ファイルを取得します。
  // (ファイルの'properties'情報も同時に取得します)
  const files = getUnprocessedJsons(DRIVE_FOLDER_ID);
  if (files.length === 0) {
    console.log("処理対象のJSONファイルはありませんでした。");
    return; // 処理終了
  }

  console.log(`${files.length}件のJSONファイルを処理します。`);

  // ★★★ v3.2 追加 ★★★
  // この実行で処理対象となったすべてのsubCategoryを収集するためのSet
  const allSubCategories = new Set();
  // ★★★ v3.2 追加ここまで ★★★

  // --- [6. 各JSONファイルのループ処理] ---
  files.forEach(file => {
    try {
      console.log(`処理開始: ${file.title} (ID: ${file.id})`);

      // 6a. JSONファイルを読み取り、内容をパースする
      const eventData = readJsonFile(file);
      
      // 必須項目（title, startTime）がなければ、不正なJSONとしてフラグを立てて終了
      if (!eventData || !eventData.title || !eventData.startTime) {
        console.warn(`JSONファイルに必要な情報(title, startTime)がありません。スキップします: ${file.title}`);
        // 不正なJSONでも、次回以降処理しないようフラグを立てる
        markFileAsProcessed(file.id); 
        return; // 次のファイルへ
      }

      // ★★★ v3.2 追加 ★★★
      // 処理対象のsubCategoryをセットに追加 (キャッシュクリア用)
      if (eventData.subCategory) {
        allSubCategories.add(eventData.subCategory);
      }
      // ★★★ v3.2 追加ここまで ★★★

      // 6b. ★★★ 新しい重複チェックロジック (v3.1) ★★★
      
      const subCategory = eventData.subCategory;
      const category = eventData.category; // ★v3.1 追加★
      
      // Driveファイルに 'processed' フラグが設定されているか確認 (v3)
      // (file.properties は getUnprocessedJsons で取得済み)
      const isProcessed = file.properties && file.properties.some(
        p => p.key === 'processed' && p.value === 'true' && p.visibility === 'PUBLIC'
      );

      // キャッシュに subCategory が存在するか確認 (v3)
      let isCached = false;
      if (subCategory) {
        isCached = cache.get(subCategory) !== null;
      }

      // --- ★★★ v3.1 議事録ロジック ★★★ ---
      // "category"が"議事録"の場合、キャッシュロジックを無視する
      if (category === "議事録") {
        
        if (!isProcessed) {
          // (A) フラグなし (新規の議事録) -> キャッシュに関わらず登録
          console.log(`[議事録/新規登録] categoryが'議事録'のため、キャッシュチェックをスキップして登録します。 subCategory: '${subCategory || 'なし'}'`);
          
          createCalendarEvent(eventData, file); // カレンダー登録
          
          // 議事録も subCategory があればキャッシュに入れる
          // (同じsubCategoryの「通常JSON」が後続にあった場合、(A-1)でブロックするため)
          if (subCategory) {
            cache.put(subCategory, 'true', 21600); // キャッシュに保存
          }
          markFileAsProcessed(file.id); // 処理済みフラグを立てる

        } else {
          // (B) フラグあり (処理済みの議事録) -> キャッシュに関わらず無視
          console.log(`[議事録/処理済み] categoryが'議事録'のため、無視します。 subCategory: '${subCategory || 'なし'}'`);
          // (要求仕様B: キャッシュの再構築も行わない)
        }
        
        console.log(`処理完了: ${file.title}`);
        return; // このファイルの処理を終了 (forEachの次のループへ)
      }
      // --- 議事録処理ここまで ---


      // --- ★★★ v3.0 標準ロジック (categoryが"議事録"以外) ★★★ ---

      if (!isProcessed) {
        // (A) 'processed' フラグが「ない」 (新規ファイル)
        
        if (subCategory) {
          // (A-1) キャッシュに「存在する」 (この実行セッション内で、既に同じsubCategoryが処理された)
          if (isCached) {
            console.log(`[キャッシュ重複] subCategory '${subCategory}' は処理中です。スキップします。`);
            markFileAsProcessed(file.id); // 重複なのでフラグのみ立てる
          } else {
          // (A-2) キャッシュに「存在しない」 (このsubCategoryはこのセッションで初)
            console.log(`[新規登録] subCategory '${subCategory}' をカレンダーに登録します。`);
            createCalendarEvent(eventData, file); // カレンダー登録
            cache.put(subCategory, 'true', 21600); // キャッシュに保存 (最大6時間)
            markFileAsProcessed(file.id); // 処理済みフラグを立てる
          }
        } else {
          // (A-3) subCategory がない場合 (v2.1のロジックを踏襲)
          // 重複チェックができないため、常に新規登録として扱う
          console.log(`[新規登録] subCategory がないため、そのまま登録します。`);
          createCalendarEvent(eventData, file);
          markFileAsProcessed(file.id);
        }

      } else {
        // (B) 'processed' フラグが「ある」 (過去に処理されたファイル)
        
        if (subCategory) {
          // (B-1) キャッシュに「存在する」
          if (isCached) {
            console.log(`[処理済み/キャッシュあり] '${subCategory}' を無視します。`);
            // 何もしない (正常な状態)
          } else {
          // (B-2) キャッシュに「存在しない」 (v3.2導入により、ほぼ毎回このルートを通る)
            // [キャッシュの再構築]
            // この「処理済みファイル」のsubCategoryをキャッシュに戻す。
            // これにより、この後に続く「未処理(A)」のファイルが(A-1)で正しく重複検知される。
            console.log(`[処理済み/キャッシュなし] '${subCategory}' をキャッシュに再保存します。`);
            cache.put(subCategory, 'true', 21600); // キャッシュに保存
          }
        } else {
           // (B-3) 処理済みで subCategory がない場合
           console.log(`[処理済み/subCategoryなし] 無視します。`);
           // 何もしない
        }
      }
      
      console.log(`処理完了: ${file.title}`);

    } catch (e) {
      // [エラーハンドリング]
      // カレンダーIDが不正など、リトライ不可能なエラーの場合
      if (e.message.startsWith("Invalid Calendar ID")) {
        console.error(`カレンダー登録に失敗しました（リトライ不可）: ${e.toString()}`);
        markFileAsProcessed(file.id); // このJSONは諦め、フラグを立てる
      } else {
        // その他の一時的なエラー (API障害、JSONパース失敗など)
        console.error(`ファイル処理中にエラーが発生しました: ${file.title || file.id} - ${e.toString()}`);
        // フラグを立てないことで、次回の実行でリトライを試みる
      }
    }
  });

  // --- [7. ★★★ v3.2 キャッシュクリア処理 ★★★] ---
  // すべての処理が完了したら、この実行で使用したsubCategoryキーをキャッシュからすべて削除する
  
  // SetをArrayに変換
  const keysToRemove = Array.from(allSubCategories);
  
  if (keysToRemove.length > 0) {
    try {
      // 関連するキーを一括削除
      cache.removeAll(keysToRemove);
      console.log(`関連する ${keysToRemove.length} 件のキャッシュを削除しました。 (Keys: ${keysToRemove.join(', ')})`);
    } catch (e) {
      console.error(`キャッシュの削除中にエラーが発生しました: ${e.toString()}`);
    }
  } else {
    console.log("キャッシュ削除対象のsubCategoryはありませんでした。");
  }
  // ★★★ v3.2 追加ここまで ★★★
}


/**
 * ★★★ 削除 (v3) ★★★
 * この関数 (checkIfEventExists) は CacheService で代替されるため不要になりました。
 */
// function checkIfEventExists(subCategory) { ... }


/**
 * ★★★ 変更 (v3) ★★★
 * 指定されたフォルダ内の「全JSONファイル」の一覧を取得します。
 * ( 'processed' フラグによる除外を廃止し、'properties' を取得するよう変更 )
 *
 * @param {string} folderId 検索対象のフォルダID
 * @return {Array<Object>} Drive API v2 の File リソースの配列 (id, title, properties を含む)
 */
function getUnprocessedJsons(folderId) {
  // ★変更★ 'processed' フラグの検索条件を削除
  // 'application/json' のみを取得
  const searchQuery = `'${folderId}' in parents and mimeType = 'application/json' and trashed = false`;
  
  try {
    let files = [];
    let pageToken;
    do {
      // Drive API v2 (Drive) を使用
      const response = Drive.Files.list({
        q: searchQuery,
        // ★変更★ 'properties' を取得対象に追加
        // 'properties' に 'processed' フラグが含まれているか後で確認するため
        fields: "nextPageToken, items(id, title, properties)", 
        pageToken: pageToken,
        maxResults: 100
      });
      if (response.items && response.items.length > 0) {
        files = files.concat(response.items);
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
    return files;
  } catch (e) {
    console.error(`Drive APIでのJSONファイル検索に失敗しました: ${e.toString()}`);
    return []; // 空の配列を返す
  }
}

/**
 * DriveのファイルオブジェクトからJSONテキストを読み取り、パースします。
 * (DriveApp (v1) を使用)
 * (変更なし)
 *
 * @param {Object} file - Drive API v2 の File リソース (id, title を持つ)
 * @return {Object} パースされたJSONオブジェクト
 * @throws {Error} 読み取りまたはパースに失敗した場合
 */
function readJsonFile(file) {
  try {
    // Drive API v2 で取得した file.id を使い、DriveApp (v1) でファイル実体を取得
    const blob = DriveApp.getFileById(file.id).getBlob();
    // BlobをUTF-8文字列として読み取り
    const jsonText = blob.getDataAsString('UTF-8');
    // 文字列をJSONオブジェクトにパース
    return JSON.parse(jsonText);
  } catch (e) {
    console.error(`JSONの読み取りまたはパースに失敗しました: ${file.title} - ${e.toString()}`);
    // 呼び出し元の try...catch で捕捉されるようエラーをスロー
    throw e;
  }
}


/**
 * JSONオブジェクトのデータを使ってGoogleカレンダーに予定を作成します。
 * (変更なし - v3.0の Calendar API v3 (insert) を維持)
 *
 * @param {Object} eventData - パースされたJSONデータ
 * @param {Object} file - 元のJSONファイル (Drive API v2 リソース)
 * @throws {Error} カレンダーIDが見つからない、またはAPI登録に失敗した場合
 */
function createCalendarEvent(eventData, file) {
  
  // (v3.2のロジックでは CalendarApp (v1) は必須ではないが、
  //  念のため getCalendarById でカレンダーの存在確認をしている)
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!calendar) {
    console.error(`指定されたカレンダーIDが見つかりません: ${CALENDAR_ID}`);
    // このエラーはリトライ不可能なため、専用のエラーをスロー
    throw new Error(`Invalid Calendar ID: ${CALENDAR_ID}`); 
  }
  
  // startTime (必須) をDateオブジェクトに変換
  const startTime = new Date(eventData.startTime);
  
  // endTime (任意) があれば変換、なければ startTime の1時間後を設定
  const endTime = (eventData.endTime) 
                  ? new Date(eventData.endTime)
                  : new Date(startTime.getTime() + 60 * 60 * 1000); // 1時間 (ミリ秒)

  // description (任意)
  let description = eventData.description || ''; 
  
  // JSON内に 'sourcePdf' (PDF抽出元) の情報があれば、説明欄に追記
  if (eventData.sourcePdf) {
    let pdfLink = '';
    // v2 API (alternateLink) または v1 API (idからURL構築) でリンクを生成
    if (eventData.sourcePdf.link) {
      pdfLink = eventData.sourcePdf.link;
    } else if (eventData.sourcePdf.id) {
      pdfLink = `https://drive.google.com/file/d/${eventData.sourcePdf.id}/view`;
    }

    if (pdfLink) {
      description += `\n\n---\n参照元PDF (${eventData.sourcePdf.title || 'リンク'}):\n${pdfLink}`;
    }
  }
  
  // Calendar API v3 (Calendar) の insert メソッドに渡すリソース本体
  const event = {
    summary: eventData.title, // 予定のタイトル
    location: eventData.location || '', // 場所
    description: description, // 説明（PDFリンク含む）
    start: { dateTime: startTime.toISOString() }, // 開始日時 (ISO 8601形式)
    end: { dateTime: endTime.toISOString() }, // 終了日時 (ISO 8601形式)
  };

  // subCategory があれば、カレンダーイベントの拡張プロパティ(shared)に保存する
  // (これにより、カレンダー側で 'subCategory=foo' の予定を検索可能になる)
  if (eventData.subCategory) {
    event.extendedProperties = {
      shared: {
        'subCategory': eventData.subCategory
      }
    };
  }

  try {
    // ★ Calendar API (v3) を使ってイベントを作成 (Calendar.Events.insert)
    Calendar.Events.insert(event, CALENDAR_ID);

    console.log(`カレンダーに予定を登録しました: ${eventData.title} (カレンダーID: ${CALENDAR_ID})`);
  } catch (e) {
    // API呼び出しの失敗 (権限不足、APIリミットなど)
    console.error(`カレンダーへの予定登録に失敗しました: ${e.toString()}`);
    // 呼び出し元の try...catch で捕捉されるようエラーをスロー
    throw e;
  }
}

/**
 * ファイルに「処理済み」であることを示すカスタムプロパティを設定します。
 * (Drive API v2 (Drive) を使用)
 * (変更なし - v2.1 PUBLIC版を維持)
 *
 * @param {string} fileId - プロパティを設定するファイルのID
 * @throws {Error} API呼び出しに失敗した場合
 */
function markFileAsProcessed(fileId) {
  try {
    // 'PUBLIC' は、このスクリプト以外（Drive UIなど）からも
    // （理論上は）参照可能であることを意味します。
    // v3.0のロジックでは、v12.1の 'PRIVATE' と揃える方が望ましいかもしれませんが、
    // v3.0の getUnprocessedJsons のロジック (properties.some) は
    // 'PUBLIC' でも 'PRIVATE' でも動作するため、機能上の問題はありません。
    const property = {
      key: 'processed',
      value: 'true',
      visibility: 'PUBLIC'
    };
    // Drive API v2 を使用してプロパティを挿入（または更新）
    Drive.Properties.insert(property, fileId);
    console.log(`ファイルに処理済みフラグを設定しました: ${fileId}`);
  } catch (e) {
    console.error(`処理済みフラグの設定に失敗しました: ${fileId} - ${e.toString()}`);
    // 呼び出し元の try...catch で捕捉されるようエラーをスロー
    throw e;
  }
}