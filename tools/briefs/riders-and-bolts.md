# Brief: passengers seen through car windows, and more Bolts at the start (owner, Nov 23)

1. "Show the passengers through the car windows." Riding together works (src/net/ride.ts, PLAN.md
   entry "Ride together"), but from outside you see only the name tag. The ride worker said car glass
   is opaque and nobody is drawn inside cars; earlier car checks described half-transparent glass with
   cabins and seats (tools/blender/cars.py, src/ent/vehicle.ts). Find out which is true at each level
   of detail and preset. Then: glass you can see through at the near and street levels (tinted,
   reflections kept), and people drawn seated in cars: the driver (player or AI) and passengers, posed
   seated with hands on the wheel for drivers, at the seat positions in PASSENGER_SEATS (tune them by
   eye per kind now that they can be seen: heads under the roof, not through doors). Players' own
   character in their own car too. Cheap: only cars within about 40 m draw occupants; phones keep
   opaque glass.
2. "At the spawn point there need to be more Bolts. They eventually all get taken." In multiplayer
   every player starts at the same place and takes the Bolt parked there. Keep a Bolt always waiting
   at the start: when the start's Bolt is taken or driven away, a fresh one appears in a free bay at the
   start a few seconds later out of everyone's sight (cap the number of spare Bolts in town so they do
   not pile up; old unattended ones are cleared like other kept cars). Shared through the host like the
   other parked cars (src/net/cars.ts). Single player: also make sure a Bolt is there after the player
   leaves one elsewhere and returns.
