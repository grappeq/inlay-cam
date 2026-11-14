(Wooden inlays app - milestone 0 air cut)
(Every move stays 5 mm or more above Z0. Nothing should touch the stock.)
(T1 D=3.175 CR=0 - ZMIN=5 - flat end mill)
(T2 D=3.175 CR=0 - ZMIN=5 - flat end mill)
G90 G94
G17
G21
(Step 1 - tool 1 - rounded square with counter-clockwise arcs)
M6 T1
S6000 M3
G54
G0 X10.000 Y5.000
G0 Z15.000
G1 Z5.000 F300
G1 X30.000 F600
G3 X35.000 Y10.000 I0.000 J5.000
G1 Y30.000
G3 X30.000 Y35.000 I-5.000 J0.000
G1 X10.000
G3 X5.000 Y30.000 I0.000 J-5.000
G1 Y10.000
G3 X10.000 Y5.000 I5.000 J0.000
G0 Z15.000
M5
(Step 2 - tool 2 - full clockwise circle then a sloped move)
M6 T2
S8000 M3
G0 X30.000 Y20.000
G0 Z15.000
G1 Z5.000 F300
G2 X30.000 Y20.000 I-10.000 J0.000 F600
G1 X20.000 Y20.000 Z10.000
G1 X10.000 Y20.000 Z5.000
G0 Z15.000
M5
G28
M30
