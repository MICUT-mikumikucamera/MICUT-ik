# 포즈·IK 준비

작성 2026-11-04. 최종 모델이 정해지기 전이라 **임시 모델(`legend_pretty_miku_refuv.blend`)로 전체 흐름을 검증한 작업물**이다.
모델이 바뀌면 코드는 그대로 두고 `examples/model_profile.json`만 새 모델 기준으로 다시 쓴다.

## 구성

| 파일 | 역할 |
|---|---|
| `poses/*.json` | 포즈 정의. 방향은 캐릭터 기준 `[오른쪽, 위, 앞]`이라 모델이 바뀌어도 재사용 가능 |
| `examples/model_profile.json` | 모델 전용 정보: 휴머노이드 뼈 매핑, 손가락·치마·머리카락 뼈, 표정 셰이프 키, 착석 접촉·몸 프록시 vertex group |
| `micut_ik/ik.py` | 엔진과 무관한 IK 수학 (2관절 IK, 착석 발 목표, 각도 제한). Blender 없이 단위 테스트 |
| `micut_ik/posing.py` | Blender에서 포즈 단계 적용, 다리·팔 IK, 시선, 표정, 머리카락·치마 정리, 몸 프록시 계산 |
| `micut_ik/contracts.py` | 배치 입력 검증. 등록된 포즈만 받음 |
| `tools/run_testset.py` | 고정 테스트 세트 렌더 → 최종 합성 → 비교 시트 |
| `tools/finalize.py` | 사진 + 미쿠 + 그림자 + 깊이 가림 → `final.jpg`, `result.json` |
| `tools/compose_depth.py` | 성윤님 저장소의 `micut_place.compose`를 모든 포즈에 쓰도록 연결 |

원본 `.blend`는 수정하지 않는다. 배율은 포즈를 적용하기 **전** 기본 자세에서 한 번 계산하므로 포즈가 바뀌어도 키 기준(신발 바닥~머리카락 끝 1.58 m)은 같다.

## 포즈

| `pose_id` | `action` | `anchor_type` | 내용 |
|---|---|---|---|
| `stand_default` | stand | `feet_center_on_ground` | 기존 연결용. 팔만 75° 내림. 이전 manifest 수치와 같음 |
| `stand_natural` | stand | `feet_center_on_ground` | 오른발에 체중, 골반 2.5 cm 내림, 팔 자연스럽게, 손가락 살짝 굽힘. 다리 IK로 발은 제자리 고정. 고개·눈은 카메라, 미소 |
| `sit_default` | sit | `pelvis_seat_contact` | 좌판 위 골반 접촉, 허벅지 앞으로, 발은 IK로 바닥에, 손은 팔 IK로 허벅지 위, 치마는 허벅지 위로, 고개·눈은 카메라 |

`sit_default`의 좌판 높이 허용 범위는 0.30~0.60 m. 범위 밖이면 `SUPPORT_OUT_OF_RANGE` 오류.
좌판이 높아 발이 안 닿으면 허벅지를 최대 15°까지 내리고, 그래도 안 닿으면 발이 뜬 채로 렌더하고 `feet_on_floor=false`, 보고서 `foot_warning`으로 알린다.

## Blender에서 직접 포즈 잡기

손으로 잡은 포즈를 `poses/<pose_id>.json`으로 바꾸는 도구가 `tools/export_pose.py`다.

1. 모델 `.blend`의 **복사본**을 `local/pose_work/`에 만들어 연다. 원본은 덮어쓰지 않는다.
2. Armature 선택 → Pose Mode → 뼈를 회전(`R`)한다. 위치 이동은 골반 루트(`Waist`)만 반영된다.
   연결된 뼈의 이동은 Blender가 무시하므로 내보내지 않고 `ignored_connected_bone_moves`로 알린다.
3. 표정은 메시 → Object Data → Shape Keys 값을 바꾼다.
4. 저장한 뒤 실행한다.

```powershell
.\scripts\export_pose.ps1 -PosedBlend local\pose_work\peace.blend -PoseId stand_peace `
  -Base poses\stand_natural.json -Description '브이 포즈'
```

- 바꾼 뼈만 기록한 뒤, 기본 자세로 되돌려 **렌더러와 같은 코드로 다시 적용**해 보고 원래 포즈와 비교한다. 0.05° / 0.5 mm 넘게 다르면 저장하지 않고 실패한다.
- 회전은 기본 자세 대비 캐릭터 기준(`[오른쪽, 위, 앞]`) 회전(`orient`)으로, 뼈 이름은 프로필의 휴머노이드·손가락 키(`left_upper_arm`, `left_index_1` 등)로 저장한다. 그래서 기본 자세가 비슷한 다른 모델에도 옮길 수 있다. 프로필에 없는 뼈(소매 등)는 원래 이름으로 저장하고 `model_specific: true`로 표시한다.
- `-Base`로 준 포즈에서 `action`, IK 모드, 시선 설정을 물려받는다. 이 설정이 켜져 있으면 해당 부위는 렌더 때 다시 계산되며, 결과 JSON의 `source.overridden_at_render`에 적힌다.
  예: `stand_natural`을 베이스로 쓰면 다리(발 고정 IK)와 고개·눈(카메라 시선)은 손으로 잡은 값 대신 렌더 때 다시 정해진다. 손으로 잡은 고개 각도를 살리려면 결과 JSON에서 `look_at`을 지운다.
- 서기에서 골반을 위로 올리면 다리가 바닥까지 닿지 않아 `reached=false`가 된다. 이때도 발바닥 기준점은 실제 발 위치로 다시 잡으므로 공중에 뜨지는 않는다.
- 새 포즈는 `examples/testset.json`에 케이스를 추가해 비교 시트로 확인한다.

## 착석 입력 (성윤님 SEATING_PREP 제안 그대로)

```json
{
  "coordinate_frame": "geometry_world",
  "unit": "m",
  "action": "sit",
  "pose_id": "sit_default",
  "anchor_type": "pelvis_seat_contact",
  "anchor_position": [0.874, 0.445, 1.481],
  "facing_rule": "world_direction",
  "facing_direction": [0.0, 0.0, -1.0],
  "support_candidate_id": 2
}
```

- `anchor_position`: 좌판 위 골반(좌골) 접촉 중심. Y = 좌판 높이.
- 골반 접촉점은 렌더 쪽에서 메시로 계산한다: 엉덩이·허벅지 위쪽 vertex group 중 고관절 기준 뒤 14 cm~앞 5 cm 범위의 가장 낮은 면.
- `support_candidate_id`는 그대로 manifest에 기록만 한다.

## manifest에 추가된 항목

| 항목 | 내용 |
|---|---|
| `local_frame` | 로컬 좌표 정의. **x = 캐릭터 오른쪽(r=[f_z,0,-f_x]), y = 위, z = 바라보는 방향, 원점 = anchor.** 성윤님 `micut_place.shape`와 같은 축 |
| `contacts` | anchor(서기는 양발 중앙, 앉기는 골반 접촉), 양발 바닥점(world·local)과 바닥과의 틈 |
| `support` | `floor` 또는 `seat`, 높이, `support_candidate_id` |
| `body_collision_proxy` | 몸 충돌 캡슐 14개(몸통, 머리, 팔·손, 다리·발). 머리카락·치마·소매 제외. 반지름 = 해당 부위 정점 거리의 85% 값 |
| `pose_report` | IK 결과: 다리·팔 도달 여부와 오차, 허벅지 각도, 발 바닥 접촉, 시선 잔여각, 표정, 정리된 머리카락·치마 뼈 수 |
| `penetration_below_support` | 바닥(앉기는 좌판 포함) 아래로 들어간 정점 수를 머리카락/치마/몸으로 나눔 |

`render_stand.py --export-shape`를 주면 `shape.npz`(성윤님 `export_stand_shape.py`와 같은 형식)를 같이 쓴다. 포즈 무관하게 깊이 합성에 쓸 수 있다.

실패 시 `error.json`에 `code`가 추가됨: `INVALID_PLACEMENT`, `SUPPORT_OUT_OF_RANGE`, `MODEL_MISMATCH`, `RENDER_FAILED`.

## 실행

```powershell
$env:BLENDER_BIN = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
uv run --no-project --with numpy --with pillow --with OpenEXR python tools/run_testset.py `
  --placement-repo ..\MICUT-placement-decision --out outputs/testset
```

`examples/testset.json`의 8개 케이스를 렌더하고 sample1 케이스는 깊이 합성까지 한다. 결과는 `outputs/testset/sheet.png`, `summary.json`.
`--debug-supports`가 켜진 케이스(가상 카메라)는 회색 바닥·좌판을 같이 렌더한다. 사진 합성에는 쓰지 않는다.
측면(`spatial.side.json`)·근접(`spatial.close.json`) 가상 카메라는 포즈 확인용이다.

## 사진 합성 (`final.jpg`, `result.json`)

데모는 IK·렌더 쪽이 최종 사진까지 만든다(2026-11-04 확정). 두 단계다.

```powershell
# 1) 렌더: --photo를 주면 사진 기반 조명, 그림자 받이 면, passes.exr(선형 색·깊이·그림자)이 켜진다
& $env:BLENDER_BIN --background local\models\<model>.blend --disable-autoexec --python-exit-code 1 `
  --python tools\render_stand.py -- --spatial local\geometry\sample1\spatial_info.json `
  --placement examples\placement.sample1.stand.json --out outputs\case --export-shape `
  --photo local\geometry\sample1\image.jpg --render-scale 1
# 2) 합성: final.jpg + result.json + debug/
uv run --no-project --with numpy --with pillow --with OpenEXR python tools\finalize.py `
  --render-dir outputs\case --geometry-dir local\geometry\sample1 --out outputs\results\case\1 `
  --placement-repo ..\MICUT-placement-decision
```

- **조명**: 사진 자체로 주변 조명을 만든다. 카메라가 본 방향은 흐린 사진 색, 못 본 방향은 사진 위쪽 띠(천장, ×1.3)·아래쪽 띠(바닥)·전체 평균. `--exposure`(기본 2)는 사진 픽셀에 섞인 물체 반사율(약 0.5)을 보정한다. 광원 방향은 따로 추정하지 않는다.
- **그림자**: 바닥(좌석이면 좌판 위도)에 그림자만 받는 투명 면을 깐다. 반지름 1.5 m 정사각형이며 가장자리에서 서서히 사라지게 한다. 사진 깊이로 그 면이 실제로 보이는 곳에만 그림자를 얹는다(테이블 받침 등 앞에 있는 물체 위에는 안 얹음).
- **가림**: 성윤님 `micut_place.compose`와 같은 규칙(사진 깊이가 미쿠보다 3 cm 넘게 가까우면 가림)을 쓰되, 미쿠 깊이는 렌더의 깊이 패스에서 가져온다. 그래서 렌더 배율과 상관없이 동작한다. `--placement-repo`를 주면 1배율에서 `micut_place.compose`를 같이 돌려 두 마스크가 얼마나 겹치는지(IoU)를 `result.json`에 남긴다.
- **해상도**: `--render-scale N`은 같은 렌즈로 화소만 N배 늘려 렌더한다. 원본 사진은 `finalize.py --photo`로 준다. 없으면 768×1024 사진을 키워 쓰고 `BACKGROUND_UPSCALED` 경고를 남긴다. 깊이는 확대해서 비교한다.
- **출력**: [OUTPUT_CONTRACT.md](OUTPUT_CONTRACT.md) 초안의 결과 폴더 형식. 실패 기준은 아직 없어서 품질 문제는 `quality.warnings`로만 남기고 `status`는 `done`.

## 한계와 다음 작업

- 머리카락·치마는 물리 없이 뼈 단위로만 정리한다. 메시 두께 때문에 일부 정점이 지지면 아래로 들어갈 수 있고, 그 수는 `penetration_below_support`로 보고한다.
- 착석은 좌판 앞 가장자리 위치를 모른다. 허벅지를 내리면 좌판 안쪽에서 허벅지 아랫면이 몇 mm~1 cm 들어갈 수 있다. 앞 가장자리를 입력으로 받으면 허벅지가 가장자리 너머에서만 내려가게 바꿀 수 있다.
- 손가락은 같은 각도로 일괄 굽힘. 손 제스처(브이, 손 흔들기)는 다음 포즈로 추가.
- 등받이·팔걸이 기대기(접촉점 여러 개)는 v2.
- 사진 없이 렌더하는 가상 카메라 케이스는 여전히 고정 스튜디오 조명.
- 사진 기반 조명은 방향성이 약해 그림자가 부드럽고 옅다. 창문·조명 위치 추정은 아직 없다.
