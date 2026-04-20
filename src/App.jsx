import { Route, Routes } from "react-router-dom";
import Contact from "./Contact.jsx";
import Home from "./Home.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/contact" element={<Contact />} />
    </Routes>
  );
}
