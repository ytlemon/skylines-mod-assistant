// electron-builder 空签名钩子：跳过 winCodeSign 下载与 Authenticode 签名，
// 直接产出「未签名」但可正常安装运行的 NSIS 安装包。
module.exports = async function disableSign() {
  return true;
};
