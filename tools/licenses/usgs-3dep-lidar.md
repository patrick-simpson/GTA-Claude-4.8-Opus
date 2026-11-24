# USGS 3DEP / Maine LiDAR (building heights)

**Source:** USGS 3D Elevation Program lidar point cloud, project ME_SouthCentral_1_B22 (collected 2022, covers Waterville, Maine), read
from the public usgs-lidar-public EPT index (https://usgs-lidar-public.s3.amazonaws.com/ME_SouthCentral_1_B22/). The National Map
product search (tnmaccess.nationalmap.gov) lists the older ME_Maine_LiDAR_NRCS_14 (2013) tiles for the same box; they are served
from a rate-limited host that would not finish downloading, and the 2022 project is newer and denser, so it was used instead. The
ME_MidCentral_1_B23 project named in the brief does not cover Waterville (checked: no points in the town's box).
**Licence:** US Government work, public domain (USGS: "there are no restrictions on use"). Credit given anyway: "Lidar: USGS 3DEP".
**What was derived:** one number per building footprint, in `src/world/footprintData.ts`: the 90th percentile of first returns above
ground inside the footprint (this project has no class-6 building returns, so the method falls back to non-ground first returns over
2.5 m; ground = the cloud's own class-2 returns), in decimetres. 760 of 775 footprints got a height. No point data is stored.
**Method:** `tools/buildings/lidar.py` (raw tiles stay outside the repo in C:\Users\User\lidar).
