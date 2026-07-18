# Maze Pathfinder

**Live demo → https://yaascine.github.io/maze-path-finder/**

An interactive maze editor and pathfinding visualizer built with plain HTML, CSS, and vanilla JavaScript — no frameworks, no build step. Draw walls, place start (A) and end (B) points, pick an algorithm, and watch it solve the maze live.

Currently implements **bidirectional Dijkstra**: two search waves expand from A and B, meet in the middle, and the shortest path lights up. A\* Search, BFS, and Greedy Best-First are coming soon.

## Features

- Click or drag to draw and erase walls; move A and B anywhere
- Live animation of both search frontiers and the final shortest path
- Speed control (Slow / Normal / Fast), switchable mid-solve
- Clear "no path found" message when A and B are sealed off

## Running locally

No dependencies. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 4173
# then open http://localhost:4173
```

## Project structure

```
index.html   Page structure
style.css    Theme, layout, animations
script.js    Grid state, min-heap, solver, animation loop
```

New algorithms plug into the `ALGORITHMS` registry at the top of `script.js`.

## About

Built by **Muhammad Yasin** —
[LinkedIn](https://www.linkedin.com/in/muhammad-yasin-7a13ba384/) ·
[GitHub](https://github.com/myasinbee25seecs-coder)
[Portfolio](https://muhammad-yasin-portfolio.netlify.app/)
