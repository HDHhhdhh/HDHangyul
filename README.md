# HDHangyul · 한귤변환기

Windows에서 HWP, HML, HWPX 문서를 HWPX와 PDF로 일괄 변환하는 데스크톱 프로그램입니다. 현재 소스 버전은 **0.2.4**입니다.

## 기능

- 파일을 끌어 놓아 변환 목록에 추가합니다.
- HWPX와 PDF 출력을 선택합니다.
- 여러 문서를 동시에 처리합니다.
- 결과를 검증한 뒤 원본 삭제 여부를 처리합니다.
- 작업 취소와 오류 로그를 지원합니다.

`원본 삭제`는 기본으로 선택됩니다. 선택한 출력이 모두 검증된 문서만 원본을 휴지통으로 이동합니다. 원본을 보관하려면 변환 전에 체크를 해제하세요.

## 실행 환경

- Windows 10/11
- 한컴오피스 한글 및 HWP Automation COM
- 개발 실행: Node.js와 Electron
- 앱 파일 생성: Python 3

한글 문서를 직접 열어 둔 상태에서는 변환 엔진 시작이 지연되거나 실패할 수 있습니다. 변환 전에 열려 있는 한글 문서를 저장하고 닫으세요.

## 소스 구성

| 경로 | 역할 |
| --- | --- |
| `electron/` | 데스크톱 창, 작업 관리, UI 연결 |
| `dist/` | 편집 가능한 HTML, CSS, JavaScript UI 소스 |
| `scripts/` | PowerShell 변환 엔진과 Windows 격리 코드 |
| `tests/` | 기존 회귀 검사와 통합 검사 도구 |
| `vendor/` | pdf-lib와 라이선스 |
| `installer/` | Windows 설치 스크립트 |

`dist/`는 이 프로젝트의 실제 UI 소스 폴더입니다. 별도의 프런트엔드 빌드 단계는 없습니다.

## 개발 실행

Electron을 준비한 개발 환경에서 저장소 루트를 앱 경로로 지정합니다.

```powershell
electron .
```

Electron 실행 파일과 한컴오피스는 이 저장소에 포함하지 않습니다.

기본 실행은 `dist/index.html`을 직접 열며 별도 개발 서버가 필요하지 않습니다. 외부 개발 서버를 사용하는 경우에만 `ELECTRON_RENDERER_URL` 또는 `VITE_DEV_SERVER_URL` 환경변수에 URL을 지정하세요. 둘 다 설정하면 `ELECTRON_RENDERER_URL`을 우선 사용합니다.

## 검사

```powershell
npm test
```

PowerShell 엔진 검사도 실행할 수 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/engine.tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/hwpx-lock.tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/engine-recycle.tests.ps1
```

## 앱 파일 생성

```powershell
python build-release.py
```

이 명령은 `release/resources/app.asar`, 외부 스크립트와 `release/manifest.json`을 생성합니다. 생성 과정에서 소스와 패키지 바이트를 검증합니다. Electron 실행 파일이나 독립 설치 파일을 새로 생성하는 명령은 아닙니다.

`build-distribution.ps1`은 기존 설치 경로의 Electron 런타임을 재사용합니다. `install-update.ps1`은 기존 한귤변환기 설치본을 대상으로 하는 업데이트 도구입니다. 설치 경로와 파일 해시 조건이 맞아야 작동합니다.

## 외부 구성 요소

- pdf-lib 1.17.1: `vendor/pdf-lib-LICENSE.md`, `vendor/SOURCES.md`
- 한컴 자동화 보안 모듈: `scripts/SOURCES.md`

외부 구성 요소의 출처와 고지를 보존했습니다. 프로젝트 자체의 별도 오픈소스 라이선스는 지정하지 않았습니다.
