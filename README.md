# MiCut IK · 배치–렌더 연결 기반

정성윤님이 전달하는 **미터 단위 바닥 위치와 방향**을 받아 기본 서기 캐릭터를 렌더하는 초기 작업물입니다. 조민재님이 모델 로더·포즈·IK·합성을 이어서 개발할 수 있도록 입력 계약, 좌표 변환, 모델 측정, 카메라 검증을 분리했습니다.

## 현재 동작

- `geometry_world` 배치 JSON과 기존 `spatial_info.json` 입력
- 원본 Blender 파일에서 캐릭터 메시·리그 로드, 고정 서기 프리셋 적용
- 지정한 키로 균일 배율 조정, 양발 사이 바닥점을 입력 위치에 정렬
- 수평 방향만 회전해 카메라 바라보기 또는 명시적 월드 방향 적용
- 기하 좌표를 Blender 좌표로 변환하고 K/R/t로 카메라 설정
- 투명 PNG, 모델 크기/기준점 manifest, 화면 잘림 검사 보고서 출력

**두 렌더 경로를 지원합니다: Blender Cycles CPU와 VRM 직접 로딩(three.js + three-vrm).** 제품의 최종 렌더 엔진을 확정한 것은 아닙니다. VRM 모델은 `local/models/miku.vrm`(VRM 1.0, SHA-256 `d82699d2…a789`, 처음 받은 `3000533088641481097 (1).vrm`과 같은 파일)에 둡니다. 처음 제공된 17KB VRM(Cube)은 다른 파일입니다.

앉기, 사람 포즈 리타게팅, 새로운 접촉 IK, 환경 충돌 해결, 깊이 기반 가림, 조명 추정은 다음 작업입니다. 기본 서기에서는 기존 리그 위에 팔을 내리는 고정 프리셋만 적용합니다.

## 빠른 실행

### VRM 직접 렌더 (Blender 불필요)

Node.js 22 이상과 Chrome/Edge 또는 Playwright Chromium이 필요합니다.

```powershell
npm ci
# 미리보기 (조명 고정, 패스 없음)
node tools/render_vrm.mjs --spatial examples/spatial.synthetic.json --placement examples/placement.preview.json --out outputs/vrm-preview
# 사진 합성용: 사진 조명 추정 + 그림자 + 합성 패스, 이어서 final.jpg
node tools/render_vrm.mjs --spatial local/geometry/sample1/spatial_info.json --placement examples/placement.sample1.stand.json `
  --photo local/geometry/sample1/image.jpg --out outputs/vrm-s1-stand
uv run --no-project --with numpy --with pillow --with OpenEXR python tools/finalize.py `
  --render-dir outputs/vrm-s1-stand --geometry-dir local/geometry/sample1 --out outputs/results/vrm-s1-stand/1
```

`--model`을 생략하면 `local/models/miku.vrm`을 씁니다. 키는 `examples/model_profile.json`의 `target_height_m`(1.58 m, 팀 확정)이고 `--height`로 바꿀 수 있습니다. 그 밖의 옵션: `--render-scale 2`(해상도 배율), `--supersample 2`(안티에일리어싱, 기본값), `--exposure 2`, `--key-share-min 0.3`, `--sky-samples 4`. 로컬 Windows Chrome/Edge를 자동 탐색합니다. 다른 브라우저는 `--browser 실행파일경로` 또는 `BROWSER_BIN`으로 지정하고, 설치된 브라우저가 없으면 `npx playwright install chromium` 후 실행합니다. 서버는 로컬 루프백에만 잠시 열고 렌더 후 종료합니다.

입력 placement·spatial, 등록 포즈(`poses/*.json`), 모델 프로필은 Blender 경로와 같습니다. VRM이 Blender 모델과 같은 리그(뼈 이름·vertex group·단위)라서 `web/vrm_pose.js`가 `micut_ik/posing.py`를 그대로 옮겨 씁니다. 출력은 `character.png`, `model_manifest.json`, `placement_report.json`(Blender와 같은 필드)이고, `--photo`를 주면 `finalize.py`가 읽는 `pass_combined.npy`(선형·premultiplied RGBA), `pass_depth.npy`(카메라 평면 깊이 m), `pass_shadow.npy`(그림자 비율)가 추가됩니다. 실패하면 `error.json`에 `code`(`INVALID_PLACEMENT`, `SUPPORT_OUT_OF_RANGE`, `MODEL_MISMATCH` 등)를 남기고 종료 코드 1.

사진 해상도 그대로 렌더해도(예: 4284×5712, `--render-scale 5.58`) 메모리와 시간이 미쿠가 화면에서 차지하는 크기에만 비례합니다. 패스는 미쿠가 닿는 화소 상자(색·깊이)와 그림자 받는 바닥 사각형이 보이는 상자(그림자)만 렌더하고, 한 변 2048 화소 이하 타일로 나눠 그립니다. 그래서 슈퍼샘플 배율이 사진 크기 때문에 줄지 않습니다. 상자 위치는 `placement_report.json`의 `pass_regions`에 있고, `finalize.py`가 이 상자를 사진 위 제자리에 놓습니다(상자 밖은 사진 화소 그대로). 결과 파일은 16 MB씩 나눠 넘기고, 렌더 전체에 `--timeout`(기본 600초) 감시 타이머가 걸려 있어 멈추면 `error.json`(`RENDER_FAILED`, 마지막 단계 포함)을 남기고 종료 코드 1로 끝납니다. `--verbose 1`은 단계별 시간을 출력합니다.

렌더 변경 확인 도구:

```powershell
# 등록 포즈 전부를 같은 장면에서 렌더·합성 → summary.json + sheet.jpg
uv run --no-project --with numpy --with pillow --with OpenEXR python tools/pose_sheet.py --out outputs/pose_sheet
# 두 렌더 폴더의 패스·final.jpg 화소 비교 (--regions full 로 렌더하면 상자 없이 전체 프레임)
uv run --no-project --with numpy --with pillow --with OpenEXR python tools/compare_renders.py outputs/a outputs/b
```

조명: 사진에서 환경광을 만들고(Blender 경로와 같은 방식), 사진에 밝은 광원이 보이면 그 방향을, 아니면 위쪽 기본 방향을 키 라이트로 떼어 내 그림자를 만듭니다. 나머지 환경광은 하늘 방향 여러 개로 나눠 바닥의 부드러운 접지 그림자를 만듭니다(긴 변 512 화소 이하로 그려 키우므로 사진 크기와 관계없이 같은 모양). 그림자 맵은 포즈를 한 번 CPU로 스키닝한 정적 메시로 그립니다. 스프링본(머리카락·치마 물리)은 돌리지 않고 뼈 단위 정리만 합니다(지지면 위로, 트윈테일은 몸·팔·치마 밖으로). 몸끼리 겹친 정도는 manifest `penetration_body`에 남습니다. PM님 프리셋은 [micut-presets](https://github.com/MICUT-mikumikucamera/micut-presets)에서 `node tools/import_presets.mjs`로 가져오고, 시선만 실제 카메라 쪽으로 다시 맞춥니다. 등록되지 않은 새 조합은 `placement.json`의 `pose_ref`로 받고, 의자에 앉는 조합은 다리만 실제 좌판 높이에 맞춥니다(자세한 규칙은 `docs/POSE_IK.md`). 다른 VRM으로 바꾸면 프로필의 뼈 이름·vertex group을 다시 확인해야 합니다.

### Blender 직접 렌더

필수: Blender 5.2(검증 버전). 순수 계약 테스트는 Python 3.10 이상.

모델과 사진은 저장소에 넣지 않고 로컬에 준비합니다. `examples/model_profile.json`은 이번 .blend의 오브젝트·뼈 이름에 맞춘 설정입니다. 다른 모델은 프로필과 기준점 추출을 다시 검증해야 합니다.

```powershell
$env:BLENDER_BIN = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'

# 인위적인 카메라로 전체 캐릭터와 바닥 기준 확인
.\scripts\render.ps1 `
  -Model 'C:\path\legend_pretty_miku_look.blend' `
  -Spatial '.\examples\spatial.synthetic.json' `
  -Placement '.\examples\placement.preview.json' `
  -Out '.\outputs\stand-preview' `
  -SaveScene

# 성윤님 입력 예시 + 석훈님 실제 기하 카메라
.\scripts\render.ps1 `
  -Model 'C:\path\legend_pretty_miku_look.blend' `
  -Spatial 'C:\path\sample1\spatial_info.json' `
  -Placement '.\examples\placement.stand.json' `
  -Out '.\outputs\geometry-sample'
```

출력:

| 파일 | 의미 |
|---|---|
| `character.png` | 입력 사진 크기와 같은 투명 렌더. 배경 합성 전 결과 |
| `model_manifest.json` | 사용 모델 SHA256, 목표 키, 배율, 외형 크기, 실제 발바닥 기준점 |
| `placement_report.json` | 처리 상태, 카메라, 투영 범위, 화면 잘림 여부 |
| `placed_scene.blend` | `-SaveScene` 사용 시 생성하는 별도 테스트 장면 |
| `error.json` | 실패 시 원인. 스크립트도 비정상 종료 코드 반환 |

원본 .blend는 저장하지 않습니다. `placed_scene.blend`는 배치 완료 테스트 장면이므로 다음 요청의 원본으로 다시 입력하지 않습니다.

## 최소 입력

```json
{
  "coordinate_frame": "geometry_world",
  "unit": "m",
  "anchor_type": "feet_center_on_ground",
  "anchor_position": [0.3, 0.0, 0.8],
  "action": "stand",
  "pose_id": "stand_default",
  "facing_rule": "look_at_camera"
}
```

`model_id`를 선택적으로 넣으면 프로필 ID와 일치하는지 검사합니다. 배치 계산에는 렌더에서 출력한 **동일 모델·포즈·배율의 manifest**를 사용합니다. 모델 원점은 입력 위치와 다를 수 있으며 어댑터가 발바닥 기준 오프셋을 적용합니다.

방향을 직접 줄 때는 `facing_rule: "world_direction"`, `facing_direction: [x, 0, z]`를 사용합니다. 0벡터는 거부합니다. 회전각 단독 입력과 앉기 등 다른 포즈는 아직 지원하지 않습니다.

## 좌표·크기 기준

- 입력 월드: X 오른쪽, Y 위쪽, Z 전방, 미터, 카메라 아래 바닥이 원점
- 카메라 위치: 원점이 아니라 `cam_to_world.t`, 예를 들어 `[0, 1.71169, 0]`
- Blender 월드: `(x, y, z) = (geometry.X, geometry.Z, geometry.Y)`
- `look_at_camera`: 카메라의 수평 위치만 사용, 모델 기울임 없음
- 기존 R은 반사를 포함하는 `det=-1` 행렬. 그대로 회전 quaternion으로 바꾸지 않음
- 카메라 변환: `F @ R @ diag(1,-1,-1)`, 위치 `F @ t`
- fx/fy/cx/cy가 없으면 임의 값을 넣지 않고 실패. 원본 K가 근사값이면 결과도 그 정확도를 상속
- 화면 잘림은 보고하되 모델을 자동으로 축소하거나 배치 위치를 임의 변경하지 않음

예제 키 **1.58m는 초기 연결 테스트 설정**입니다. 캐릭터 목표 키로 확정한 값이 아닙니다. 전체 외형 경계에는 머리카락·의상·손까지 포함합니다. 신체 충돌 프록시나 실제 빈 공간 판정 결과로 해석하지 않습니다.

## 테스트

```powershell
python -m unittest discover -s tests -v
& $env:BLENDER_BIN --background --factory-startup --disable-autoexec --python-exit-code 1 --python tools/test_blender_camera.py
```

두 번째 명령은 서로 다른 이미지 크기, fx/fy, 주점에서 Blender 투영과 기하 투영을 비교합니다. 모델은 필요하지 않습니다.

실제 출력 검사:

```powershell
python tools/check_outputs.py outputs/stand-preview --expected-anchor 0 0 3.2 --require-in-frame
python tools/check_outputs.py outputs/geometry-sample --expected-anchor 0.3 0 0.8
```

## 포즈·IK

등록 포즈는 `stand_default`, `stand_natural`, `sit_default`(착석, `pelvis_seat_contact`). 포즈 정의·착석 입력·manifest 추가 항목·테스트 세트 실행은 [포즈·IK 준비](docs/POSE_IK.md) 참고. VRM 경로(`web/`)는 아직 `stand_default`만 받는다.

## 인수인계

- [작업 규칙 (AGENTS.md)](AGENTS.md): 환경, 명령, 지켜야 할 것
- [포즈·IK 사용법](docs/POSE_IK.md)
- [민재님 인수인계 (10/30 원문)](docs/HANDOFF_MINJAE.md)
- [성윤님 전달용 모델·좌표 기준](docs/HANDOFF_SUNGYOON.md)
- [검증 결과와 모델 파일 문제](docs/VALIDATION.md)

모델 파일과 파생 .blend, 사진·렌더 이미지는 기본 Git 제외입니다. 제공받은 VRM의 메타데이터에는 배포 제한 표기가 있습니다. 모델 원본·파생물의 외부 공유 조건은 별도 확인 후 결정합니다. 이 저장소에는 실행 코드와 수치 검사 자료만 추가합니다.

참고: [Blender Object API](https://docs.blender.org/api/current/bpy.types.Object.html), [Blender Camera API](https://docs.blender.org/api/current/bpy.types.Camera.html)

VRM 로딩 참고: [three-vrm 공식 문서](https://pixiv.github.io/three-vrm/docs/)
