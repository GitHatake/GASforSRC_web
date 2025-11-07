# SRC_web GAS Projects

このリポジトリは、`SRC_web`というWebサイトの機能をサポートするためのGoogle Apps Script (GAS) プロジェクト群です。

## プロジェクト概要

各ディレクトリが独立したGASプロジェクトとなっています。

### `json2googleCalendar/`

JSON形式のデータをGoogleカレンダーに登録する機能を提供します。

*   [`json2googleCalendar/.clasp.json`](json2googleCalendar/.clasp.json): Google Apps ScriptのCLIツール `clasp` の設定ファイルです。
*   [`json2googleCalendar/appsscript.json`](json2googleCalendar/appsscript.json): GASプロジェクトのマニフェストファイルです。APIのスコープなどを定義します。
*   [`json2googleCalendar/json2googleCalendar.js`](json2googleCalendar/json2googleCalendar.js): JSONデータを受け取り、Googleカレンダーにイベントとして登録するロジックが記述されたメインのスクリプトファイルです。

### `jsonEditor/`

JSONデータを編集するためのWebエディタを提供するプロジェクトです。

*   [`jsonEditor/.clasp.json`](jsonEditor/.clasp.json): `clasp` の設定ファイルです。
*   [`jsonEditor/appsscript.json`](jsonEditor/appsscript.json): GASプロジェクトのマニフェストファイルです。
*   [`jsonEditor/Editor.html`](jsonEditor/Editor.html): JSONエディタのUIを定義するHTMLファイルです。
*   [`jsonEditor/Index.html`](jsonEditor/Index.html): WebアプリケーションのメインページとなるHTMLファイルです。
*   [`jsonEditor/jsonEditor.js`](jsonEditor/jsonEditor.js): サーバーサイドのロジックを記述したスクリプトファイルです。HTMLとの連携やデータの処理を行います。
*   [`jsonEditor/Stylesheet.html`](jsonEditor/Stylesheet.html): UIのスタイルを定義するCSSが含まれたHTMLファイルです。

### `pdf2summary/`

PDFファイルからテキストを抽出し、要約を生成する機能を持つプロジェクトです。

*   [`pdf2summary/.clasp.json`](pdf2summary/.clasp.json): `clasp` の設定ファイルです。
*   [`pdf2summary/appsscript.json`](pdf2summary/appsscript.json): GASプロジェクトのマニフェストファイルです。
*   [`pdf2summary/pdf2sumary.js`](pdf2summary/pdf2sumary.js): PDFを処理し、要約を生成するロジックが記述されたメインのスクリプトファイルです。

### `removePropeties/`

オブジェクトから不要なプロパティを削除するユーティリティプロジェクトです。

*   [`removePropeties/.clasp.json`](removePropeties/.clasp.json): `clasp` の設定ファイルです。
*   [`removePropeties/appsscript.json`](removePropeties/appsscript.json): GASプロジェクトのマニフェストファイルです。
*   [`removePropeties/removeProperties.js`](removePropeties/removeProperties.js): データオブジェクトから特定のプロパティを削除する処理を実装したスクリプトファイルです。

### `summary2portalSite/`

生成された要約をポータルサイトに投稿・反映させるためのプロジェクトです。

*   [`summary2portalSite/.clasp.json`](summary2portalSite/.clasp.json): `clasp` の設定ファイルです。
*   [`summary2portalSite/appsscript.json`](summary2portalSite/appsscript.json): GASプロジェクトのマニフェストファイルです。
*   [`summary2portalSite/index.html`](summary2portalSite/index.html): 操作用のUIを提供するHTMLファイルです。
*   [`summary2portalSite/summary2portalSite.js`](summary2portalSite/summary2portalSite.js): 要約データを受け取り、ポータルサイトにコンテンツとして反映させるロジックが記述されたスクリプトファイルです。

## ライセンス

このプロジェクトは [`LICENSE`](LICENSE) ファイルに記載されたライセンスに基づき、Apache Licenseで制作されています。