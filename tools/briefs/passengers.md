# Brief: ride together: a player joins another player's car as a passenger (owner, Nov 23)

Owner: "Allow a passenger to join a car and ride together."

- In multiplayer, a player on foot near a car another player is driving presses the get-in key (F, or
  the touch Get in key) and takes a free passenger seat instead of the driver's; the prompt says
  "Ride with <name>". Up to the car's seat count (sedan 3 passengers, coupe and sports 1, bus many,
  pickup and tow 1 or 2, Bolt and C-Max 4): add seat positions per kind in vehicleSpecs.
- The passenger is drawn seated in that seat on every screen (today another player's taxi rider is not
  drawn at all: fix that too), moves with the car smoothly, and gets out with F (or is thrown out in a
  crash or when the car is wrecked; reuse the ragdoll if it exists by then, otherwise the knock-over).
- Passenger camera: the chase camera on the shared car, free look with the mouse or drag; a passenger
  can shoot from the window (drive-by, existing weapons) and change the radio only on their own screen.
- The driver's browser stays the car's authority; the passenger's browser follows the driver's car
  state (src/net/cars.ts, conn.ts); entering and leaving go through the protocol as small messages.
  Handle the driver leaving, crashing, disconnecting or the host changing (passenger left standing
  beside the car safely). AI shared cars and parked cars: not in scope (players' cars only).
- Single player: Dess cannot be a passenger (nothing to ride with), unchanged.
- Tests: a tools/net/ride.mjs with two or three headless browsers on the local service: get in, ride
  across town, both screens agree on positions, get out, driver leaves mid-ride, passenger reconnects.
  tsc clean, server tests pass, boots with no errors. A protocol change bumps the version and needs the
  Worker redeployed (say so in the report: the lead asks the owner to press Run in kvbcawana).
