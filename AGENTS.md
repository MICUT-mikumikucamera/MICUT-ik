# AGENTS.md

미컷 IK·렌더 저장소. 배치 파트(성윤님)가 준 위치·방향으로 3D 미쿠에 포즈를 잡고(IK 포함) 사진 카메라에 맞춰 렌더한다.
사람과 코딩 에이전트가 같이 읽는 작업 규칙이다. 자세한 사용법은 [docs/POSE_IK.md](docs/POSE_IK.md).

## 환경

- Blender 5.2 LTS (`$env:BLENDER_BIN = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'`)
- Python 3.10+ (계약·IK 단위 테스트는 표준 라이브러리만 사용)
- 테스트 세트·깊이 합성 도구는 numpy, pillow 필요: `uv run --no-project --with numpy --with pillow python ...`
- 깊이 합성은 배치 저장소 `MICUT--placement-decision`을 옆 폴더에 클론해 `--placement-repo`로 넘긴다
- VRM 경로(`web/`, `tools/render_vrm.mjs`)는 Node 22+ (`npm ci`). 아직 `stand_default`만 받는다

## 파일 위치

| 경로 | 내용 |
|---|---|
| `micut_ik/contracts.py` | 배치 입력 검증, 좌표 변환. **bpy 의존 금지** (Blender 밖 단위 테스트) |
| `micut_ik/ik.py` | 엔진 독립 IK 수학. **bpy 의존 금지** |
| `micut_ik/posing.py` | Blender 포즈 적용, IK, 시선, 머리카락·치마 정리, 몸 프록시 |
| `micut_ik/blender_adapter.py` | 모델 로드·배율·배치·카메라·렌더·manifest |
| `poses/*.json` | 등록 포즈. 여기 있는 `pose_id`만 입력으로 받는다 |
| `examples/model_profile.json` | 모델 전용 이름·축·vertex group. 모델 교체 시 이 파일만 새로 쓴다 |
| `examples/testset.json` | 회귀 테스트 세트 |
| `tools/render_stand.py` | Blender 진입점 (모든 포즈) |
| `tools/export_pose.py` | Blender에서 손으로 잡은 포즈 → 포즈 JSON |
| `local/` | 모델·사진·기하 산출물 (Git 제외) |
| `outputs/` | 렌더 결과 (Git 제외) |

## 명령

```powershell
python -m unittest discover -s tests -v      # 계약·IK 단위 테스트
npm test                                      # VRM 경로 JS 테스트
uv run --no-project --with numpy --with pillow python tools/run_testset.py `
  --placement-repo ..\MICUT-placement-decision --out outputs/testset   # 전체 렌더 + 합성 + 비교 시트
.\scripts\render.ps1 -Model local\models\<model>.blend -Spatial <spatial.json> -Placement <placement.json> -Out outputs\x -ExportShape
.\scripts\export_pose.ps1 -PosedBlend local\pose_work\<copy>.blend -PoseId <id> -Base poses\stand_natural.json
```

## 지켜야 할 것

- **저장소는 public이다.** 모델(`.blend`, `.vrm`), 사진, 렌더 이미지, 깊이 배열은 커밋하지 않는다. 수치 JSON만 `docs/validation/`에 남긴다.
- 원본 `.blend`는 저장하지 않는다. 장면 저장은 `--save-scene`으로 출력 폴더에 새 파일로만.
- 배율은 포즈 적용 전 기본 자세에서 한 번 계산한다(신발 바닥~머리카락 끝 = 1.58 m, 팀 확정). 사진·카메라·포즈에 따라 다시 맞추지 않는다. 화면 잘림은 보고만 하고 자동 축소·이동하지 않는다.
- 좌표: 입력 `geometry_world`는 미터, X 오른쪽·Y 위·Z 앞, 카메라 아래 바닥이 원점, R은 det = -1. 축 변환은 렌더 쪽에서만 한다.
- manifest 로컬 좌표는 x = 캐릭터 오른쪽(r = [f_z, 0, -f_x]), y = 위, z = 바라보는 방향, 원점 = anchor. 배치 저장소 `micut_place.shape`와 같아야 한다.
- 포즈 파일은 캐릭터 기준 `[오른쪽, 위, 앞]`으로 쓰고 뼈는 프로필 키(`left_upper_arm`, `left_index_1` 등)로 부른다. 모델 전용 뼈 이름을 쓰면 `model_specific: true`.
- `stand_default`는 이전 manifest와 수치가 같아야 한다(배치 저장소가 이 수치로 검사함). 포즈·IK 코드를 바꾸면 `docs/validation/stand_model_manifest.json`의 크기·로컬 경계·발 접촉점과 비교한다(1e-6 m 이내).
- 포즈·IK를 바꾼 뒤에는 단위 테스트와 테스트 세트를 돌리고 `sheet.png`를 눈으로 확인한다. `summary.json`의 `legs_reached`, `feet_on_floor`, `penetration_vertices`를 본다.
- 입력 계약을 바꾸면 `docs/HANDOFF_SUNGYOON.md`와 `docs/POSE_IK.md`를 같이 고친다.
- 문서는 한국어, 코드·주석은 영어.
