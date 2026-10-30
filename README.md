# MiCut IK · 배치–렌더 연결 기반

정성윤님이 전달하는 **미터 단위 바닥 위치와 방향**을 받아 기본 서기 캐릭터를 렌더하는 초기 작업물입니다. 조민재님이 모델 로더·포즈·IK·합성을 이어서 개발할 수 있도록 입력 계약, 좌표 변환, 모델 측정, 카메라 검증을 분리했습니다.

## 현재 동작

- `geometry_world` 배치 JSON과 기존 `spatial_info.json` 입력
- 원본 Blender 파일에서 캐릭터 메시·리그 로드, 고정 서기 프리셋 적용
- 지정한 키로 균일 배율 조정, 양발 사이 바닥점을 입력 위치에 정렬
- 수평 방향만 회전해 카메라 바라보기 또는 명시적 월드 방향 적용
- 기하 좌표를 Blender 좌표로 변환하고 K/R/t로 카메라 설정
- 투명 PNG, 모델 크기/기준점 manifest, 화면 잘림 검사 보고서 출력

**현재 렌더 환경은 Blender Cycles CPU입니다.** 제품의 최종 렌더 엔진을 확정한 것은 아닙니다. .blend는 직접 사용하고, VRM은 별도 검사만 합니다. 범용 VRM 로더나 three-vrm/Unity 구현은 포함하지 않았습니다.

앉기, 사람 포즈 리타게팅, 새로운 접촉 IK, 환경 충돌 해결, 깊이 기반 가림, 조명 추정은 다음 작업입니다. 기본 서기에서는 기존 리그 위에 팔을 내리는 고정 프리셋만 적용합니다.

## 빠른 실행

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

## 인수인계

- [민재님 인수인계](docs/HANDOFF_MINJAE.md)
- [성윤님 전달용 모델·좌표 기준](docs/HANDOFF_SUNGYOON.md)
- [검증 결과와 모델 파일 문제](docs/VALIDATION.md)

모델 파일과 파생 .blend, 사진·렌더 이미지는 기본 Git 제외입니다. 제공받은 VRM의 메타데이터에는 배포 제한 표기가 있습니다. 모델 원본·파생물의 외부 공유 조건은 별도 확인 후 결정합니다. 이 저장소에는 실행 코드와 수치 검사 자료만 추가합니다.

참고: [Blender Object API](https://docs.blender.org/api/current/bpy.types.Object.html), [Blender Camera API](https://docs.blender.org/api/current/bpy.types.Camera.html)
