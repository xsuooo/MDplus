@echo off
chcp 65001 >nul
echo 正在注册 MDPlus 文件关联...
echo.

set "MDPLUS_PATH=%LOCALAPPDATA%\MDPlus\MDPlus.exe"

if not exist "%MDPLUS_PATH%" (
    echo 错误：找不到 MDPlus 安装文件
    echo 路径：%MDPLUS_PATH%
    echo.
    echo 请确认 MDPlus 已正确安装
    pause
    exit /b 1
)

echo 找到 MDPlus: %MDPLUS_PATH%
echo.

rem 注册 .md 文件关联
reg add "HKCU\Software\Classes\.md" /ve /t REG_SZ /d "MDPlus.markdown" /f >nul 2>&1
reg add "HKCU\Software\Classes\.markdown" /ve /t REG_SZ /d "MDPlus.markdown" /f >nul 2>&1

rem 创建文件类型
reg add "HKCU\Software\Classes\MDPlus.markdown" /ve /t REG_SZ /d "Markdown 文档" /f >nul 2>&1
reg add "HKCU\Software\Classes\MDPlus.markdown\DefaultIcon" /ve /t REG_SZ /d "\"%MDPLUS_PATH%\",0" /f >nul 2>&1
reg add "HKCU\Software\Classes\MDPlus.markdown\shell\open\command" /ve /t REG_SZ /d "\"%MDPLUS_PATH%\" \"%%1\"" /f >nul 2>&1

rem 添加到"打开方式"菜单
reg add "HKCU\Software\Classes\Applications\MDPlus.exe\shell\open\command" /ve /t REG_SZ /d "\"%MDPLUS_PATH%\" \"%%1\"" /f >nul 2>&1
reg add "HKCU\Software\Classes\Applications\MDPlus.exe" /v "FriendlyAppName" /t REG_SZ /d "MDPlus" /f >nul 2>&1

echo.
echo ✓ 文件关联注册成功！
echo.
echo 现在你可以：
echo 1. 双击 .md 文件直接用 MDPlus 打开
echo 2. 右键 .md 文件 → 打开方式 中看到 MDPlus
echo.
pause
